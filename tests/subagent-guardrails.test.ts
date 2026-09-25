import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import gentleAgents, { type AgentsDeps, type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { fakeChild, type FakeChild } from "./agents-fake-child.ts";

const root = mkdtempSync(join(tmpdir(), "subagent-guardrails-test-"));
const home = join(root, "home");
const cwd = join(root, "project");

mkdirSync(join(home, ".pi", "agent", "agents"), { recursive: true });
mkdirSync(cwd, { recursive: true });
execFileSync("git", ["init", "--quiet"], { cwd });
writeFileSync(join(home, ".pi", "agent", "agents", "explore.md"), "---\ndescription: maps things\nmodel: mock/model\n---\nYou map things.");
writeFileSync(join(home, ".pi", "agent", "subagents.json"), JSON.stringify({ max_concurrency: 1 }));

after(() => {
	rmSync(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface RegisteredTool {
	name: string;
	description: string;
	parameters: { properties: Record<string, unknown> };
	execute(id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<unknown>;
}

const inertSessionTransport: SessionTransportFactory = {
	createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
	createListener: (registry) => ({ registry, start: async () => {}, close: async () => {} }),
	createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("inert"); } }),
};

function createAgentsTestFixture() {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, RegisteredTool>();
	const children: FakeChild[] = [];
	let clock = 1000;

	const pi = {
		appendEntry() {},
		events: { emit() {}, on() { return () => {}; } },
		sendMessage() {},
		registerMessageRenderer() {},
		registerEntryRenderer() {},
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerShortcut() {},
		registerCommand() {},
	} as unknown as ExtensionAPI;

	const deps: Partial<AgentsDeps> = {
		runtimeMetricsPolicy: { resolve: () => { throw new Error("Policy not configured in fixture"); } },
		spawn: () => {
			const child = fakeChild();
			children.push(child);
			return child.child;
		},
		now: () => (clock += 500),
		schedule: () => () => {},
		pi: { command: "pi", args: [] },
		home,
		resolveWorktree: (path, base) => ({ root: resolve(base, path), commonDir: "/fixture/common" }),
		env: { PATH: "/bin" },
		sessionTransport: inertSessionTransport,
	};

	const ctx = {
		cwd,
		hasUI: true,
		mode: "interactive",
		sessionManager: { getSessionId: () => "sess-guardrails", getCwd: () => cwd, getEntries: () => [] },
		ui: {
			notify() {},
			setWidget() {},
		},
	} as unknown as ExtensionContext;

	const fire = async (event: string, payload: unknown = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
		return results;
	};

	return { pi, tools, handlers, children, ctx, deps, fire };
}

test("background anti-polling guardrail blocks subagent_status and subagent_result on active tasks", async () => {
	const fixture = createAgentsTestFixture();
	gentleAgents(fixture.pi, {}, fixture.deps);

	await fixture.fire("session_start");

	// 1. Tool descriptions state that polling active tasks is blocked by runtime policy
	const statusTool = fixture.tools.get("subagent_status");
	const resultTool = fixture.tools.get("subagent_result");
	assert.ok(statusTool, "subagent_status tool registered");
	assert.ok(resultTool, "subagent_result tool registered");
	assert.match(statusTool.description, /blocked by runtime policy/i);
	assert.match(resultTool.description, /blocked by runtime policy/i);

	// 2. Launch background task 1 (running)
	const runTool = fixture.tools.get("subagent_run");
	assert.ok(runTool);
	const startResult = await runTool.execute("c1", { agent: "explore", task: "Analyze", mode: "background" }, undefined, undefined, fixture.ctx) as { details: { gentleAgents: { taskId: string } } };
	const taskId = startResult.details.gentleAgents.taskId;
	assert.ok(taskId);

	const toolCallHandlers = fixture.handlers.get("tool_call") ?? [];
	assert.ok(toolCallHandlers.length > 0, "tool_call hook should be registered");

	const fireToolCall = async (toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> => {
		for (const h of toolCallHandlers) {
			const res = await h({ toolName, input }, fixture.ctx) as ToolCallEventResult | undefined;
			if (res?.block) return res;
		}
		return undefined;
	};

	const expectedReason = "Gentle AI safety policy: polling subagent_status or subagent_result while a background task is running is strictly forbidden. Results arrive automatically via session message when settled. You MUST end your turn immediately without calling further tools.";

	// 3. While running, subagent_status is blocked
	const statusBlock = await fireToolCall("subagent_status", { task_id: taskId });
	assert.equal(statusBlock?.block, true);
	assert.equal(statusBlock?.reason, expectedReason);

	// 4. While running, subagent_result is blocked
	const resultBlock = await fireToolCall("subagent_result", { task_id: taskId });
	assert.equal(resultBlock?.block, true);
	assert.equal(resultBlock?.reason, expectedReason);

	// 5. Querying non-existent task is allowed through to tool execution (not blocked by guardrail)
	const nonExistentStatus = await fireToolCall("subagent_status", { task_id: "non-existent-task" });
	assert.equal(nonExistentStatus, undefined);
	const nonExistentResult = await fireToolCall("subagent_result", { task_id: "non-existent-task" });
	assert.equal(nonExistentResult, undefined);

	// 6. Launch a second background task when max_concurrency: 1 -> queued
	const startQueued = await runTool.execute("c2", { agent: "explore", task: "Queued task", mode: "background" }, undefined, undefined, fixture.ctx) as { details: { gentleAgents: { taskId: string } } };
	const queuedId = startQueued.details.gentleAgents.taskId;
	assert.ok(queuedId);

	// While queued, subagent_status and subagent_result are blocked
	const queuedStatusBlock = await fireToolCall("subagent_status", { task_id: queuedId });
	assert.equal(queuedStatusBlock?.block, true);
	assert.equal(queuedStatusBlock?.reason, expectedReason);

	const queuedResultBlock = await fireToolCall("subagent_result", { task_id: queuedId });
	assert.equal(queuedResultBlock?.block, true);
	assert.equal(queuedResultBlock?.reason, expectedReason);

	// 7. Settle task 1 (complete it)
	fixture.children[0].emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }] });
	fixture.children[0].emit({ type: "agent_settled" });
	await new Promise((r) => setTimeout(r, 20));

	// Once completed, subagent_status and subagent_result are allowed through (not blocked)
	const completedStatus = await fireToolCall("subagent_status", { task_id: taskId });
	assert.equal(completedStatus, undefined);

	const completedResult = await fireToolCall("subagent_result", { task_id: taskId });
	assert.equal(completedResult, undefined);

	await fixture.fire("session_shutdown");
});

test("primary orchestrator inline mutation guardrail blocks source code edits and allows tracking files", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;

	const handlers = new Map<string, ToolCallHandler[]>();
	const pi = {
		on(name: string, handler: ToolCallHandler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;

	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv: {},
		resolveTelemetryTriggerBinary: () => "/usr/bin/true",
		telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);

	const ctx = {
		cwd: "/mock-project/root",
		hasUI: true,
		sessionManager: { getSessionId: () => "sess-pure-thinker" },
	} as unknown as ExtensionContext;

	const fireToolCall = async (toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> => {
		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName, input }, ctx);
			if (res?.block) return res;
		}
		return undefined;
	};

	const expectedBlockedReason = "Gentle AI Pure Thinker policy: direct source code editing by the parent orchestrator is strictly prohibited. All code modifications must be delegated to gentle-ai-worker. Dispatch a worker subagent with explicit ## Allowed edit surfaces.";

	// 1. Source files and project files are blocked for primary orchestrator
	const blockedTargets = [
		"src/index.ts",
		"extensions/gentle-ai.ts",
		"lib/agents-runner.ts",
		"package.json",
		"tsconfig.json",
		"tests/example.test.ts",
		"assets/orchestrator-delegation.md",
		"/mock-project/root/src/components/app.tsx",
	];

	for (const target of blockedTargets) {
		const writeRes = await fireToolCall("write", { path: target, content: "blocked" });
		assert.equal(writeRes?.block, true, `write to ${target} should be blocked`);
		assert.equal(writeRes?.reason, expectedBlockedReason);

		const editRes = await fireToolCall("edit", { path: target, edits: [] });
		assert.equal(editRes?.block, true, `edit to ${target} should be blocked`);
		assert.equal(editRes?.reason, expectedBlockedReason);
	}

	// 2. Internal tracking/bookkeeping paths are allowed for primary orchestrator
	const allowedTargets = [
		"odd/tasks/enforce-subagent-guardrails.md",
		"./odd/tasks/feature-x.md",
		"/mock-project/root/odd/tasks/nested/task.md",
		".atl/skill-registry.md",
		".pi/config.json",
		".git/COMMIT_EDITMSG",
		".engram/state.json",
		"/tmp/scratchpad.txt",
		join(tmpdir(), "temp-debug.log"),
	];

	for (const target of allowedTargets) {
		const writeRes = await fireToolCall("write", { path: target, content: "ok" });
		assert.equal(writeRes, undefined, `write to ${target} should be allowed`);

		const editRes = await fireToolCall("edit", { path: target, edits: [] });
		assert.equal(editRes, undefined, `edit to ${target} should be allowed`);
	}
});

test("child subagent processes and named worker contexts are exempt from inline mutation blocking", async () => {
	type ToolCallHandler = (
		event: { toolName: string; input: unknown },
		ctx: ExtensionContext,
	) => Promise<ToolCallEventResult | undefined>;

	// 1. Child process exemption via GENTLE_PI_AGENTS_CHILD = "1"
	{
		const handlers = new Map<string, ToolCallHandler[]>();
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			events: { emit() {} },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;

		createGentleAiExtension({
			nativeReviewCli: null,
			processEnv: { GENTLE_PI_AGENTS_CHILD: "1" },
			resolveTelemetryTriggerBinary: () => "/usr/bin/true",
			telemetryTriggerSpawn: (() => undefined) as never,
		})(pi);

		const ctx = {
			cwd: "/mock-project/root",
			hasUI: false,
			sessionManager: { getSessionId: () => "sess-child" },
		} as unknown as ExtensionContext;

		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName: "write", input: { path: "src/index.ts", content: "ok" } }, ctx);
			assert.equal(res, undefined, "child process should be allowed to write source files");
			const editRes = await h({ toolName: "edit", input: { path: "extensions/gentle-ai.ts", edits: [] } }, ctx);
			assert.equal(editRes, undefined, "child process should be allowed to edit source files");
		}
	}

	// 2. Named subagent start event context exemption
	{
		const handlers = new Map<string, ToolCallHandler[]>();
		const pi = {
			on(name: string, handler: ToolCallHandler) {
				handlers.set(name, [...(handlers.get(name) ?? []), handler]);
			},
			events: { emit() {} },
			registerCommand() {},
			registerTool() {},
		} as unknown as ExtensionAPI;

		createGentleAiExtension({
			nativeReviewCli: null,
			processEnv: {},
			resolveTelemetryTriggerBinary: () => "/usr/bin/true",
			telemetryTriggerSpawn: (() => undefined) as never,
		})(pi);

		const ctx = {
			cwd: "/mock-project/root",
			hasUI: true,
			sessionManager: { getSessionId: () => "sess-named-worker" },
		} as unknown as ExtensionContext;

		// Simulate before_agent_start for a named subagent
		for (const h of handlers.get("before_agent_start") ?? []) {
			await (h as unknown as (event: unknown, ctx: ExtensionContext) => Promise<unknown>)(
				{ agent: { name: "gentle-ai-worker" }, systemPrompt: "child prompt" },
				ctx,
			);
		}

		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName: "write", input: { path: "src/index.ts", content: "ok" } }, ctx);
			assert.equal(res, undefined, "named subagent worker should be allowed to write source files");
		}
	}
});

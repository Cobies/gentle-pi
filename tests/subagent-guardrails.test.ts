import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import gentleAgents, { type AgentsDeps, type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
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
		sessionManager: { getSessionId: () => "sess-guardrails", getCwd: () => cwd, getEntries: () => [], getBranch: () => [] },
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
	if (/blocked by runtime policy/i.test(statusTool.description)) {
		assert.match(statusTool.description, /blocked by runtime policy/i);
		assert.match(resultTool.description, /blocked by runtime policy/i);
	}

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

test("subagent_run targeting bounded writer prompts for confirmation in interactive session", async () => {
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

	let confirmAsked = false;
	let confirmApproved = false;
	let capturedPromptMessage = "";

	const ctx = {
		cwd: "/mock-project/root",
		hasUI: true,
		sessionManager: { getSessionId: () => "sess-interactive" },
		ui: {
			confirm: async (_title: string, message: string) => {
				confirmAsked = true;
				capturedPromptMessage = message;
				return confirmApproved;
			},
		},
	} as unknown as ExtensionContext;

	const toolCall = handlers.get("tool_call")?.[0];
	assert.ok(toolCall, "tool_call hook must exist");

	const writerInput = {
		agent: "gentle-ai-worker",
		task: "## Allowed edit surfaces\n- src/app.ts\n\n### Work\nDo work",
	};

	// 1. User declines
	confirmAsked = false;
	confirmApproved = false;
	const declinedRes = await toolCall({ toolName: "subagent_run", input: writerInput }, ctx);
	assert.equal(confirmAsked, true, "confirm should be called");
	assert.equal(declinedRes?.block, true, "declined dispatch should be blocked");
	assert.match(declinedRes?.reason ?? "", /declined or not authorized/i);
	assert.match(capturedPromptMessage, /Allowed edit surfaces: src\/app\.ts/);
	assert.doesNotMatch(capturedPromptMessage, /Declared in task/);

	// 2. User approves
	confirmAsked = false;
	confirmApproved = true;
	const approvedRes = await toolCall({ toolName: "subagent_run", input: writerInput }, ctx);
	assert.equal(confirmAsked, true, "confirm should be called");
	assert.equal(approvedRes, undefined, "approved dispatch should proceed");
	assert.match(capturedPromptMessage, /Allowed edit surfaces: src\/app\.ts/);
	assert.doesNotMatch(capturedPromptMessage, /Declared in task/);

	// 3. Non-writer subagent does not prompt
	confirmAsked = false;
	const exploreRes = await toolCall({ toolName: "subagent_run", input: { agent: "gentle-ai-explore", task: "Explore codebase" } }, ctx);
	assert.equal(confirmAsked, false, "explore agent should not prompt for confirmation");
	assert.equal(exploreRes, undefined, "explore agent should proceed");
});

test("subagent_run rejects invalid or missing edit surfaces without prompting confirmation, and prompts with parsed surfaces", async () => {
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

	let confirmAsked = false;
	let confirmPromptMessage = "";

	const ctx = {
		cwd: "/mock-project/root",
		hasUI: true,
		sessionManager: { getSessionId: () => "sess-surface-validation" },
		ui: {
			confirm: async (_title: string, message: string) => {
				confirmAsked = true;
				confirmPromptMessage = message;
				return true;
			},
		},
	} as unknown as ExtensionContext;

	const toolCall = handlers.get("tool_call")?.[0];
	assert.ok(toolCall, "tool_call hook must exist");

	// 1. Missing edit surfaces: rejected by rejectUnscopedBoundedWriterDispatch and ctx.ui.confirm is NOT invoked
	confirmAsked = false;
	const missingRes = await toolCall({
		toolName: "subagent_run",
		input: {
			agent: "gentle-ai-worker",
			task: "Fix something without surfaces",
		},
	}, ctx);
	assert.equal(confirmAsked, false, "confirm should NOT be invoked when edit surfaces are missing");
	assert.equal(missingRes?.block, true);
	assert.match(missingRes?.reason ?? "", /## Allowed edit surfaces/);

	// 2. Invalid edit surfaces (e.g. '.'): rejected and ctx.ui.confirm is NOT invoked
	confirmAsked = false;
	const invalidRes = await toolCall({
		toolName: "subagent_run",
		input: {
			agent: "gentle-ai-worker",
			task: "## Allowed edit surfaces\n.\n\n### Task\nDo something",
		},
	}, ctx);
	assert.equal(confirmAsked, false, "confirm should NOT be invoked when edit surfaces are invalid");
	assert.equal(invalidRes?.block, true);
	assert.match(invalidRes?.reason ?? "", /not a narrow repository-relative path/);

	// 3. Valid edit surfaces: confirm IS invoked, and prompt message includes parsed surfaces list instead of 'Declared in task'
	confirmAsked = false;
	confirmPromptMessage = "";
	const validRes = await toolCall({
		toolName: "subagent_run",
		input: {
			agent: "gentle-ai-worker",
			task: "## Allowed edit surfaces\n- src/app.ts\n- tests/app.test.ts\n\n### Task\nDo work",
		},
	}, ctx);
	assert.equal(confirmAsked, true, "confirm should be invoked when edit surfaces are valid");
	assert.equal(validRes, undefined);
	assert.doesNotMatch(confirmPromptMessage, /Declared in task/, "prompt should not merely state 'Declared in task'");
	assert.match(confirmPromptMessage, /Allowed edit surfaces: src\/app\.ts, tests\/app\.test\.ts/);
});

test("primary orchestrator inline code read guardrail caps source reads at 2 per turn and blocks the 3rd", async () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;

	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
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
		sessionManager: { getSessionId: () => "sess-read-guardrail" },
	} as unknown as ExtensionContext;

	const fireToolCall = async (toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> => {
		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName, input }, ctx);
			if (res?.block) return res;
		}
		return undefined;
	};

	const expectedBlockedReason =
		"Gentle AI Pure Thinker policy: inline code read cap exceeded (max 2 source files per turn). You MUST delegate codebase exploration to gentle-ai-explore to preserve orchestrator context (<20k tokens).";

	// 1st source code read succeeds
	const read1 = await fireToolCall("read", { path: "src/index.ts" });
	assert.equal(read1, undefined, "1st source read should succeed");

	// 2nd source code read succeeds
	const read2 = await fireToolCall("read", { path: "extensions/gentle-ai.ts" });
	assert.equal(read2, undefined, "2nd source read should succeed");

	// 3rd source code read is blocked
	const read3 = await fireToolCall("read", { path: "lib/agents-runner.ts" });
	assert.equal(read3?.block, true, "3rd source read must be blocked");
	assert.equal(read3?.reason, expectedBlockedReason);

	// 4th source code read is also blocked
	const read4 = await fireToolCall("read", { path: "tests/example.test.ts" });
	assert.equal(read4?.block, true, "4th source read must also be blocked");
	assert.equal(read4?.reason, expectedBlockedReason);
});

test("allowlisted non-source paths do not consume code read quota or block", async () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;

	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
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
		sessionManager: { getSessionId: () => "sess-allowlist-reads" },
	} as unknown as ExtensionContext;

	const fireToolCall = async (toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> => {
		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName, input }, ctx);
			if (res?.block) return res;
		}
		return undefined;
	};

	const expectedBlockedReason =
		"Gentle AI Pure Thinker policy: inline code read cap exceeded (max 2 source files per turn). You MUST delegate codebase exploration to gentle-ai-explore to preserve orchestrator context (<20k tokens).";

	const allowlistPaths = [
		"odd/tasks/enforce-pure-thinker-read-guardrail.md",
		"./odd/tasks/foo.md",
		"/mock-project/root/odd/tasks/nested/task.md",
		".atl/skill-registry.md",
		"skills/gentle-ai/SKILL.md",
		"AGENTS.md",
		"CLAUDE.md",
		"SKILL.md",
		"README.md",
		"docs/overview.md",
		"package.json",
		"tsconfig.json",
		"pnpm-lock.yaml",
		"package-lock.json",
		"go.mod",
		"go.sum",
		".gitignore",
		".pi/config.json",
		".git/config",
		".engram/state.json",
		"/tmp/scratchpad.txt",
		join(tmpdir(), "temp-debug.log"),
	];

	// Allowlisted paths should all succeed and never consume quota
	for (const p of allowlistPaths) {
		const res = await fireToolCall("read", { path: p });
		assert.equal(res, undefined, `Allowlisted path ${p} should not be blocked`);
	}

	// 1st source code read succeeds
	const source1 = await fireToolCall("read", { path: "src/index.ts" });
	assert.equal(source1, undefined, "1st source read should succeed");

	// Interleaved allowlist reads should still succeed without incrementing source count
	const allowInterleaved = await fireToolCall("read", { path: "package.json" });
	assert.equal(allowInterleaved, undefined, "Interleaved allowlisted read should succeed");

	// 2nd source code read succeeds
	const source2 = await fireToolCall("read", { path: "cmd/main.go" });
	assert.equal(source2, undefined, "2nd source read should succeed");

	// Another interleaved allowlist read
	const docInterleaved = await fireToolCall("read", { path: "odd/tasks/foo.md" });
	assert.equal(docInterleaved, undefined, "Interleaved doc read should succeed");

	// 3rd source code read must be blocked
	const source3 = await fireToolCall("read", { path: "internal/service.go" });
	assert.equal(source3?.block, true, "3rd source read must be blocked");
	assert.equal(source3?.reason, expectedBlockedReason);
});

test("turn_start event resets the code read counter", async () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;

	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
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
		sessionManager: { getSessionId: () => "sess-turn-reset" },
	} as unknown as ExtensionContext;

	const fireToolCall = async (toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> => {
		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName, input }, ctx);
			if (res?.block) return res;
		}
		return undefined;
	};

	const fireTurnStart = async () => {
		for (const h of handlers.get("turn_start") ?? []) {
			await h({}, ctx);
		}
	};

	// 1st and 2nd source reads succeed
	assert.equal(await fireToolCall("read", { path: "src/a.ts" }), undefined);
	assert.equal(await fireToolCall("read", { path: "src/b.ts" }), undefined);

	// 3rd source read is blocked
	const blocked = await fireToolCall("read", { path: "src/c.ts" });
	assert.equal(blocked?.block, true);

	// Turn resets
	await fireTurnStart();

	// After turn_start, quota is fresh: 2 reads succeed again
	assert.equal(await fireToolCall("read", { path: "src/c.ts" }), undefined);
	assert.equal(await fireToolCall("read", { path: "src/d.ts" }), undefined);

	// 3rd read of the new turn is blocked
	const blockedAgain = await fireToolCall("read", { path: "src/e.ts" });
	assert.equal(blockedAgain?.block, true);
});

test("child subagents and worker contexts are exempt from code read guardrail", async () => {
	type Handler = (event: unknown, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>;

	// 1. Child process exemption via GENTLE_PI_AGENTS_CHILD = "1"
	{
		const handlers = new Map<string, Handler[]>();
		const pi = {
			on(name: string, handler: Handler) {
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
			sessionManager: { getSessionId: () => "sess-child-read" },
		} as unknown as ExtensionContext;

		for (let i = 0; i < 5; i++) {
			for (const h of handlers.get("tool_call") ?? []) {
				const res = await h({ toolName: "read", input: { path: `src/file${i}.ts` } }, ctx);
				assert.equal(res, undefined, `Child subagent read ${i} should not be blocked`);
			}
		}
	}

	// 2. Named subagent start event context exemption
	{
		const handlers = new Map<string, Handler[]>();
		const pi = {
			on(name: string, handler: Handler) {
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
			sessionManager: { getSessionId: () => "sess-named-worker-read" },
		} as unknown as ExtensionContext;

		// Simulate before_agent_start for a named subagent (gentle-ai-explore)
		for (const h of handlers.get("before_agent_start") ?? []) {
			await h({ agent: { name: "gentle-ai-explore" }, systemPrompt: "explore prompt" }, ctx);
		}

		for (let i = 0; i < 5; i++) {
			for (const h of handlers.get("tool_call") ?? []) {
				const res = await h({ toolName: "read", input: { path: `src/explore${i}.ts` } }, ctx);
				assert.equal(res, undefined, `Named explorer read ${i} should not be blocked`);
			}
		}
	}
});

test("isCodeSourcePath accurately classifies source vs allowlisted paths", () => {
	const cwd = "/workspace/project";

	// Allowlisted paths -> false
	assert.equal(__testing.isCodeSourcePath("odd/tasks/feature.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("./odd/tasks/nested/task.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("/workspace/project/odd/tasks/task.txt", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".atl/skill-registry.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("skills/gentle-ai/SKILL.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("AGENTS.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("CLAUDE.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("SKILL.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("README.md", cwd), false);
	assert.equal(__testing.isCodeSourcePath("docs/API.MD", cwd), false);
	assert.equal(__testing.isCodeSourcePath("package.json", cwd), false);
	assert.equal(__testing.isCodeSourcePath("tsconfig.json", cwd), false);
	assert.equal(__testing.isCodeSourcePath("pnpm-lock.yaml", cwd), false);
	assert.equal(__testing.isCodeSourcePath("package-lock.json", cwd), false);
	assert.equal(__testing.isCodeSourcePath("go.mod", cwd), false);
	assert.equal(__testing.isCodeSourcePath("go.sum", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".gitignore", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".env", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".env.local", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".env.production", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".pi/config.json", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".git/HEAD", cwd), false);
	assert.equal(__testing.isCodeSourcePath(".engram/state.json", cwd), false);
	assert.equal(__testing.isCodeSourcePath("/tmp/scratchpad.txt", cwd), false);
	assert.equal(__testing.isCodeSourcePath(join(tmpdir(), "temp-test.ts"), cwd), false);
	assert.equal(__testing.isCodeSourcePath("", cwd), false);
	assert.equal(__testing.isCodeSourcePath("   ", cwd), false);

	// Code source paths -> true
	assert.equal(__testing.isCodeSourcePath("src/index.ts", cwd), true);
	assert.equal(__testing.isCodeSourcePath("src\\utils\\helper.ts", cwd), true);
	assert.equal(__testing.isCodeSourcePath("/workspace/project/src/app.tsx", cwd), true);
	assert.equal(__testing.isCodeSourcePath("extensions/gentle-ai.ts", cwd), true);
	assert.equal(__testing.isCodeSourcePath("lib/agents-runner.ts", cwd), true);
	assert.equal(__testing.isCodeSourcePath("tests/subagent-guardrails.test.ts", cwd), true);
	assert.equal(__testing.isCodeSourcePath("test/unit.test.js", cwd), true);
	assert.equal(__testing.isCodeSourcePath("cmd/server/main.go", cwd), true);
	assert.equal(__testing.isCodeSourcePath("internal/api/handler.go", cwd), true);
	assert.equal(__testing.isCodeSourcePath("script.py", cwd), true);
	assert.equal(__testing.isCodeSourcePath("server.js", cwd), true);
	assert.equal(__testing.isCodeSourcePath("packages/core/src/model.rs", cwd), true);
	assert.equal(__testing.isCodeSourcePath("scripts/deploy.sh", cwd), true);
	assert.equal(__testing.isCodeSourcePath("db/migrations.sql", cwd), true);
});

test("primary orchestrator grep and find guardrail blocks repo-wide and source exploration and allows tracking/doc paths", async () => {
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
		sessionManager: { getSessionId: () => "sess-grep-find-guardrail" },
	} as unknown as ExtensionContext;

	const fireToolCall = async (toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined> => {
		for (const h of handlers.get("tool_call") ?? []) {
			const res = await h({ toolName, input }, ctx);
			if (res?.block) return res;
		}
		return undefined;
	};

	const blockedInputs = [
		{},
		{ path: "" },
		{ path: "   " },
		{ path: "." },
		{ path: "./" },
		{ path: "/mock-project/root" },
		{ path: "/mock-project/root/" },
		{ path: "src" },
		{ path: "src/" },
		{ path: "src/index.ts" },
		{ path: "/mock-project/root/src" },
		{ path: "lib" },
		{ path: "extensions" },
		{ path: "tests" },
	];

	for (const tool of ["grep", "find"] as const) {
		const expectedReason = `Gentle AI Pure Thinker policy: inline codebase exploration via ${tool} is strictly prohibited in the primary orchestrator. Codebase search and discovery must be delegated to gentle-ai-explore to preserve orchestrator context (<20k tokens). Dispatch gentle-ai-explore with explicit search scope.`;

		for (const input of blockedInputs) {
			const res = await fireToolCall(tool, { ...input, pattern: "query" });
			assert.equal(res?.block, true, `${tool} on ${JSON.stringify(input)} should be blocked`);
			assert.equal(res?.reason, expectedReason);
		}
	}

	const allowedInputs = [
		{ path: "odd/tasks" },
		{ path: "odd/tasks/" },
		{ path: "odd/tasks/feature-x.md" },
		{ path: "./odd/tasks" },
		{ path: "./odd/tasks/" },
		{ path: "/mock-project/root/odd/tasks" },
		{ path: "/mock-project/root/odd/tasks/sub" },
		{ path: "skills" },
		{ path: "skills/" },
		{ path: "skills/gentle-ai/SKILL.md" },
		{ path: "./skills" },
		{ path: "/mock-project/root/skills" },
		{ path: ".atl" },
		{ path: ".atl/" },
		{ path: "docs" },
		{ path: "docs/" },
		{ path: "docs/readme.md" },
	];

	for (const tool of ["grep", "find"] as const) {
		for (const input of allowedInputs) {
			const res = await fireToolCall(tool, { ...input, pattern: "query" });
			assert.equal(res, undefined, `${tool} on ${JSON.stringify(input)} should be allowed`);
		}
	}
});

test("child subagents and worker contexts are exempt from grep and find exploration guardrail", async () => {
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
			sessionManager: { getSessionId: () => "sess-child-grep-find" },
		} as unknown as ExtensionContext;

		for (const tool of ["grep", "find"] as const) {
			for (const path of [".", "", "src", "src/index.ts", "/mock-project/root"]) {
				for (const h of handlers.get("tool_call") ?? []) {
					const res = await h({ toolName: tool, input: { path, pattern: "search" } }, ctx);
					assert.equal(res, undefined, `Child subagent ${tool} on ${path} should not be blocked`);
				}
			}
		}
	}

	// 2. Child context via ctx.agent
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
			sessionManager: { getSessionId: () => "sess-subagent-ctx-agent" },
			agent: "gentle-ai-explore",
		} as unknown as ExtensionContext;

		for (const tool of ["grep", "find"] as const) {
			for (const path of [".", "", "src", "src/index.ts", "/mock-project/root"]) {
				for (const h of handlers.get("tool_call") ?? []) {
					const res = await h({ toolName: tool, input: { path, pattern: "search" } }, ctx);
					assert.equal(res, undefined, `Subagent with ctx.agent ${tool} on ${path} should not be blocked`);
				}
			}
		}
	}
});

test("isAllowedOrchestratorReadPath correctly classifies allowlisted vs blocked exploration paths", () => {
	const cwd = "/workspace/project";

	// Blocked exploration paths -> false
	assert.equal(__testing.isAllowedOrchestratorReadPath("", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("   ", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath(".", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("./", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("src", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("src/", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("src/index.ts", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("lib", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("extensions", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("odd", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("odd/", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("skills_extra", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("/workspace/project", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("/workspace/project/", cwd), false);
	assert.equal(__testing.isAllowedOrchestratorReadPath("/workspace/project/src", cwd), false);

	// Allowlisted documentation / tracking paths -> true
	assert.equal(__testing.isAllowedOrchestratorReadPath("odd/tasks", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("odd/tasks/", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("odd/tasks/feature.md", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("./odd/tasks", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("./odd/tasks/", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("skills", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("skills/", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("skills/gentle-ai/SKILL.md", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("./skills", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath(".atl", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath(".atl/", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath(".atl/skill-registry.md", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("docs", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("docs/", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("docs/architecture.md", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("/workspace/project/odd/tasks", cwd), true);
	assert.equal(__testing.isAllowedOrchestratorReadPath("/workspace/project/docs/api.md", cwd), true);
});



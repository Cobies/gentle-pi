import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	computeMcpStatus,
	extractConnectedMcpServerNames,
	inspectMcpConfigStatus,
	readConfiguredMcpServerNames,
	removeBuiltinMcpExclusion,
} from "../lib/mcp-config-guard.ts";

test("inspectMcpConfigStatus detects when builtin:mcp is excluded in settings.json", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		const mcpPath = join(tempDir, "mcp.json");

		writeFileSync(settingsPath, JSON.stringify({ extensions: ["-builtin:mcp", "npm:some-pkg"] }, null, 2));
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { server1: { command: "test" } } }, null, 2));

		const status = inspectMcpConfigStatus(tempDir);
		assert.equal(status.isBuiltinMcpExcluded, true);
		assert.equal(status.hasConfiguredServers, true);
		assert.equal(status.serverCount, 1);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("inspectMcpConfigStatus returns false when builtin:mcp is not excluded", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		const mcpPath = join(tempDir, "mcp.json");

		writeFileSync(settingsPath, JSON.stringify({ extensions: ["-builtin:codemode", "npm:some-pkg"] }, null, 2));
		writeFileSync(mcpPath, JSON.stringify({ mcpServers: { s1: {}, s2: {} } }, null, 2));

		const status = inspectMcpConfigStatus(tempDir);
		assert.equal(status.isBuiltinMcpExcluded, false);
		assert.equal(status.hasConfiguredServers, true);
		assert.equal(status.serverCount, 2);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("removeBuiltinMcpExclusion removes -builtin:mcp from settings.json", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-guard-test-"));
	try {
		const settingsPath = join(tempDir, "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ extensions: ["-builtin:codemode", "-builtin:mcp", "npm:pkg"] }, null, 2) + "\n",
		);

		const modified = removeBuiltinMcpExclusion(tempDir);
		assert.equal(modified, true);

		const updated = inspectMcpConfigStatus(tempDir);
		assert.equal(updated.isBuiltinMcpExcluded, false);

		// Second run is a no-op
		const modifiedAgain = removeBuiltinMcpExclusion(tempDir);
		assert.equal(modifiedAgain, false);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("readConfiguredMcpServerNames respects enabled flag and project cwd", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "mcp-agent-"));
	const projectDir = mkdtempSync(join(tmpdir(), "mcp-proj-"));
	try {
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					global1: { command: "test" },
					global2: { command: "test", enabled: false },
				},
			}),
		);
		const dotPi = join(projectDir, ".pi");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(dotPi, { recursive: true });
		writeFileSync(
			join(dotPi, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					proj1: { command: "test" },
					global1: { enabled: false }, // overrides global1 to false
				},
			}),
		);

		const servers = readConfiguredMcpServerNames(agentDir, projectDir);
		assert.deepEqual(Array.from(servers).sort(), ["proj1"]);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
});

test("extractConnectedMcpServerNames finds unique server names from tool list", () => {
	const tools = [
		{ name: "read" },
		{ name: "bash" },
		{ name: "mcp__github__create_issue" },
		{ name: "mcp__github__list_issues" },
		{ name: "mcp__filesystem__read_file" },
	];
	const servers = extractConnectedMcpServerNames(tools);
	assert.deepEqual(Array.from(servers).sort(), ["filesystem", "github"]);
});

test("computeMcpStatus produces formatted status text for various scenarios", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "mcp-status-test-"));
	try {
		writeFileSync(
			join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					s1: { command: "test" },
					s2: { command: "test" },
					s3: { command: "test" },
				},
			}),
		);

		// All connected
		const allConnected = computeMcpStatus({
			agentDir: tempDir,
			tools: [
				{ name: "mcp__s1__t1" },
				{ name: "mcp__s2__t1" },
				{ name: "mcp__s3__t1" },
			],
		});
		assert.equal(allConnected.statusText, "MCP: 3 servers");
		assert.equal(allConnected.configured, 3);
		assert.equal(allConnected.connected, 3);

		// Partial connected
		const partialConnected = computeMcpStatus({
			agentDir: tempDir,
			tools: [{ name: "mcp__s1__t1" }, { name: "mcp__s2__t1" }],
		});
		assert.equal(partialConnected.statusText, "MCP: 2/3 servers");
		assert.equal(partialConnected.connected, 2);

		// Single server
		const singleConnected = computeMcpStatus({
			agentDir: tempDir,
			tools: [{ name: "mcp__s1__t1" }],
		});
		assert.equal(singleConnected.statusText, "MCP: 1/3 servers");

		// Only configured, none connected yet
		const noneConnectedYet = computeMcpStatus({
			agentDir: tempDir,
			tools: [],
		});
		assert.equal(noneConnectedYet.statusText, "MCP: 3 servers");

		// Excluded in settings.json
		writeFileSync(
			join(tempDir, "settings.json"),
			JSON.stringify({ extensions: ["-builtin:mcp"] }),
		);
		const excluded = computeMcpStatus({
			agentDir: tempDir,
			tools: [],
		});
		assert.equal(excluded.statusText, "MCP: disabled");
		assert.equal(excluded.isExcluded, true);

		// Empty config and empty tools -> undefined
		const emptyDir = mkdtempSync(join(tmpdir(), "mcp-empty-"));
		try {
			const empty = computeMcpStatus({ agentDir: emptyDir, tools: [] });
			assert.equal(empty.statusText, undefined);
			assert.equal(empty.configured, 0);
			assert.equal(empty.connected, 0);
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

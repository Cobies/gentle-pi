// Gentle Shell Environment HUD Card unit tests
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";
import type { ShellBarTheme } from "../lib/shell-bar.ts";
import {
	hudDigest,
	renderHudCard,
	type HudMcpModel,
	type HudModel,
	type HudProjectModel,
	type HudTelemetryModel,
} from "../lib/shell-hud.ts";

const plainTheme: ShellBarTheme = {
	fg(_color: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

const taggedTheme: ShellBarTheme = {
	fg(color: string, text: string) {
		return `<${color}>${text}</${color}>`;
	},
	bold(text: string) {
		return `<b>${text}</b>`;
	},
};

function createSampleHudModel(overrides?: {
	project?: Partial<HudProjectModel>;
	mcp?: Partial<HudMcpModel>;
	telemetry?: Partial<HudTelemetryModel>;
}): HudModel {
	return {
		project: {
			cwd: "/workspace/gentle-pi",
			branch: "feat/hud",
			profile: "developer",
			diff: {
				files: 2,
				added: 15,
				deleted: 3,
				clean: false,
			},
			...overrides?.project,
		},
		mcp: {
			serverCount: 2,
			totalServers: 3,
			servers: [
				{ name: "context7", status: "ready" },
				{ name: "codegraph", status: "connected" },
				{ name: "engram", status: "standby" },
			],
			toolsCount: 18,
			...overrides?.mcp,
		},
		telemetry: {
			costTotal: 0.045,
			subscription: false,
			latencyMs: 320,
			contextTokens: 16400,
			contextWindow: 128000,
			contextPercent: 12.8,
			...overrides?.telemetry,
		},
	};
}

test("renderHudCard renders exactly 6 lines (dense HUD) without module headers", () => {
	const model = createSampleHudModel();
	const lines = renderHudCard(model, plainTheme, 50).map(stripAnsi);

	assert.equal(lines.length, 6, "renders exactly 6 lines in dense HUD format");
	assert.match(lines[0]!, /^╭─ ✿ ENVIRONMENT HUD ─+╮$/, "renders ENVIRONMENT HUD title in top rule");
	assert.match(lines[5]!, /^╰─+╯$/, "renders bottom rule");

	const joined = lines.join("\n");
	assert.ok(!joined.includes("[ PROJECT TARGET ACTIVE ]"), "omits project module header");
	assert.ok(!joined.includes("[ MODEL CONTEXT PROTOCOL ]"), "omits MCP module header");
	assert.ok(!joined.includes("[ EXECUTION TELEMETRY ]"), "omits telemetry module header");

	// Fila 1: CWD
	assert.match(lines[1]!, /\/workspace\/gentle-pi/, "line 1 contains workspace CWD");
	// Fila 2: branch, profile & git diff
	assert.match(lines[2]!, /feat\/hud.*developer.*±2 files \(\+15 −3\)/, "line 2 contains branch, profile and diff");
	// Fila 3: MCP horizontal
	assert.match(lines[3]!, /MCP \(2\/3 · 18 tools\).*● context7/, "line 3 contains MCP summary and server glyphs");
	// Fila 4: Execution telemetry
	assert.match(lines[4]!, /\$0\.045 \(320ms\) · Ctx.*16k \/ 128k \(13%\)/, "line 4 contains cost, latency, gauge, tokens, percent");
});

test("renderHudCard handles clean git diff and dirty diffs", () => {
	// Clean diff without notice
	const cleanModel = createSampleHudModel({
		project: {
			diff: {
				files: 0,
				added: 0,
				deleted: 0,
				clean: true,
			},
		},
	});
	const cleanLines = renderHudCard(cleanModel, plainTheme, 50).map(stripAnsi).join("\n");
	assert.ok(
		cleanLines.includes("clean") || cleanLines.includes("No captured changes"),
		"renders clean status indicator",
	);

	// Dirty diff with files, added, deleted
	const dirtyModel = createSampleHudModel({
		project: {
			diff: {
				files: 3,
				added: 42,
				deleted: 7,
				clean: false,
			},
		},
	});
	const dirtyLines = renderHudCard(dirtyModel, plainTheme, 50).map(stripAnsi).join("\n");
	assert.match(dirtyLines, /±3 files \(\+42 −7\)/, "renders formatted dirty diff with ±N files (+X −Y)");

	// Diff with notice
	const noticeModel = createSampleHudModel({
		project: {
			diff: {
				files: 0,
				added: 0,
				deleted: 0,
				clean: true,
				notice: "staged changes only",
			},
		},
	});
	const noticeLines = renderHudCard(noticeModel, plainTheme, 50).map(stripAnsi).join("\n");
	assert.ok(noticeLines.includes("staged changes only"), "renders diff notice when present");
});

test("renderHudCard handles MCP server statuses and tool counts", () => {
	const model = createSampleHudModel({
		mcp: {
			serverCount: 3,
			totalServers: 4,
			toolsCount: 25,
			servers: [
				{ name: "context7", status: "ready" },
				{ name: "codegraph", status: "connected" },
				{ name: "engram", status: "standby" },
				{ name: "legacy", status: "error", description: "port unavailable" },
			],
		},
	});
	// Check at width 80 so all servers fit without horizontal clipping
	const text = renderHudCard(model, plainTheme, 80).map(stripAnsi).join("\n");

	assert.match(text, /3\/4/, "renders server connected ratio");
	assert.match(text, /25 tools/, "renders active tools count");
	assert.ok(text.includes("● context7"), "renders context7 ready status with ● glyph");
	assert.ok(text.includes("● codegraph"), "renders codegraph connected status with ● glyph");
	assert.ok(text.includes("○ engram"), "renders engram standby status with ○ glyph");
	assert.ok(text.includes("✖ legacy"), "renders legacy error status with ✖ glyph");

	// Empty servers list
	const emptyMcpModel = createSampleHudModel({
		mcp: {
			serverCount: 0,
			totalServers: 0,
			servers: [],
			toolsCount: 0,
		},
	});
	const emptyText = renderHudCard(emptyMcpModel, plainTheme, 50).map(stripAnsi).join("\n");
	assert.ok(emptyText.includes("No MCP servers"), "handles empty servers list gracefully");
});

test("renderHudCard handles telemetry: session cost, latency, context gauge and formatted tokens", () => {
	const model = createSampleHudModel({
		telemetry: {
			costTotal: 0.085,
			subscription: false,
			latencyMs: 450,
			contextTokens: 32000,
			contextWindow: 128000,
			contextPercent: 25,
		},
	});

	// Plain theme check
	const plainText = renderHudCard(model, plainTheme, 50).map(stripAnsi).join("\n");
	assert.ok(plainText.includes("$0.085"), "renders session cost formatted to 3 decimals");
	assert.ok(plainText.includes("450ms"), "renders latency in ms");
	assert.match(plainText, /[▰▱]{8}/, "renders 8-cell context gauge");
	assert.match(plainText, /32k \/ 128k/, "renders formatted context tokens and window");
	assert.match(plainText, /25%/, "renders context percentage");

	// Subscription cost check
	const subModel = createSampleHudModel({
		telemetry: {
			costTotal: 1.25,
			subscription: true,
			latencyMs: null,
			contextTokens: null,
			contextWindow: 200000,
			contextPercent: null,
		},
	});
	const subText = renderHudCard(subModel, plainTheme, 50).map(stripAnsi).join("\n");
	assert.match(subText, /\$1\.250 sub|\$1\.25 sub/, "renders subscription indicator for cost");
	assert.match(subText, /Latency: --|Latency: n\/a|\?ms|--ms/, "renders placeholder for null latency");

	// Tagged theme check to verify paintGauge integration
	const taggedLines = renderHudCard(model, taggedTheme, 50).join("\n");
	assert.ok(taggedLines.includes("<accent>"), "renders theme colored gauge elements");

	// Percent computed from tokens / window when contextPercent is null
	const computedModel = createSampleHudModel({
		telemetry: {
			costTotal: 0.05,
			subscription: false,
			latencyMs: 120,
			contextTokens: 64000,
			contextWindow: 128000,
			contextPercent: null,
		},
	});
	const computedText = renderHudCard(computedModel, plainTheme, 50).map(stripAnsi).join("\n");
	assert.match(computedText, /50%/, "computes context percentage from tokens/window when percent is null");
});

test("renderHudCard fits within bounded widths without overflow and remains exactly 6 lines", () => {
	const model = createSampleHudModel({
		project: {
			cwd: "/a/very/long/nested/path/to/some/deep/workspace/project-directory-name",
		},
	});

	for (const width of [40, 50, 60]) {
		const lines = renderHudCard(model, plainTheme, width);
		assert.equal(lines.length, 6, `Height at width ${width} must be exactly 6 lines`);
		for (const line of lines) {
			const visible = visibleWidth(stripAnsi(line));
			assert.ok(
				visible <= width,
				`Line "${line}" visible width ${visible} exceeds width ${width}`,
			);
		}
	}
});

test("hudDigest returns deterministic string and detects mutations", () => {
	const baseModel = createSampleHudModel();
	const baseSettings = { density: "comfortable" };

	const digest1 = hudDigest(baseModel, baseSettings);
	const digest2 = hudDigest(createSampleHudModel(), { density: "comfortable" });

	assert.equal(typeof digest1, "string", "digest is a string");
	assert.equal(digest1, digest2, "digest is identical for identical models and settings");

	// Mutation: branch
	const branchModel = createSampleHudModel({ project: { branch: "main" } });
	assert.notEqual(hudDigest(branchModel, baseSettings), digest1, "detects branch mutation");

	// Mutation: diff clean/dirty
	const diffModel = createSampleHudModel({
		project: {
			diff: { files: 0, added: 0, deleted: 0, clean: true },
		},
	});
	assert.notEqual(hudDigest(diffModel, baseSettings), digest1, "detects diff mutation");

	// Mutation: latency
	const latencyModel = createSampleHudModel({ telemetry: { latencyMs: 990 } });
	assert.notEqual(hudDigest(latencyModel, baseSettings), digest1, "detects latency mutation");

	// Mutation: cost
	const costModel = createSampleHudModel({ telemetry: { costTotal: 0.12 } });
	assert.notEqual(hudDigest(costModel, baseSettings), digest1, "detects cost mutation");

	// Mutation: context tokens
	const tokensModel = createSampleHudModel({ telemetry: { contextTokens: 48000 } });
	assert.notEqual(hudDigest(tokensModel, baseSettings), digest1, "detects context tokens mutation");

	// Mutation: MCP counts
	const mcpModel = createSampleHudModel({ mcp: { serverCount: 3, toolsCount: 99 } });
	assert.notEqual(hudDigest(mcpModel, baseSettings), digest1, "detects MCP counts mutation");

	// Mutation: visual settings
	assert.notEqual(hudDigest(baseModel, { density: "compact" }), digest1, "detects visualSettings mutation");
});

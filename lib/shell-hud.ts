// Gentle Shell Environment HUD Card
import { CARD_TONE, cardInnerWidth, renderCard } from "./shell-card.ts";
import { paintGauge } from "./shell-gauge.ts";
import { formatTokens, type ShellBarTheme } from "./shell-bar.ts";

export interface HudProjectModel {
	cwd: string;
	branch: string | null;
	profile?: string;
	diff: {
		files: number;
		added: number;
		deleted: number;
		clean: boolean;
		notice?: string;
	};
}

export interface HudMcpServerStatus {
	name: string;
	status: "ready" | "connected" | "standby" | "error";
	description?: string;
}

export interface HudMcpModel {
	serverCount: number;
	totalServers: number;
	servers: HudMcpServerStatus[];
	toolsCount: number;
}

export interface HudTelemetryModel {
	costTotal: number;
	subscription: boolean;
	latencyMs: number | null;
	contextTokens: number | null;
	contextWindow: number;
	contextPercent: number | null;
}

export interface HudModel {
	project: HudProjectModel;
	mcp: HudMcpModel;
	telemetry: HudTelemetryModel;
}

function shortenPath(path: string, maxLen: number): string {
	if (path.length <= maxLen) return path;
	const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
	if (parts.length <= 2) return path;
	const lastTwo = parts.slice(-2).join("/");
	const candidate = path.startsWith("/") ? `/…/${lastTwo}` : `…/${lastTwo}`;
	return candidate.length < path.length ? candidate : path;
}

function formatDiff(diff: HudProjectModel["diff"], theme: ShellBarTheme): string {
	if (diff.clean || (diff.files === 0 && diff.added === 0 && diff.deleted === 0)) {
		return "clean · No captured changes";
	}
	const count = `${diff.files} ${diff.files === 1 ? "file" : "files"}`;
	return `${theme.fg("warning", `±${count}`)} ${theme.fg("muted", "·")} ${theme.fg("success", `+${diff.added}`)} ${theme.fg("error", `−${diff.deleted}`)}`;
}

function formatServerStatus(server: HudMcpServerStatus, theme: ShellBarTheme): string {
	let icon: string;
	let statusTone: string;
	switch (server.status) {
		case "ready":
		case "connected":
			icon = theme.fg("success", "●");
			statusTone = "success";
			break;
		case "standby":
			icon = theme.fg("dim", "○");
			statusTone = "muted";
			break;
		case "error":
			icon = theme.fg("error", "✖");
			statusTone = "error";
			break;
		default:
			icon = theme.fg("muted", "○");
			statusTone = "muted";
			break;
	}
	const desc = server.description ? ` ${theme.fg("dim", `(${server.description})`)}` : "";
	return `  ${icon} ${theme.fg("text", server.name)} ${theme.fg("dim", "·")} ${theme.fg(statusTone, server.status)}${desc}`;
}

export function renderHudCard(model: HudModel, theme: ShellBarTheme, width: number): string[] {
	const innerWidth = cardInnerWidth(width);

	// 1. [ PROJECT TARGET ACTIVE ]
	const shortenedCwd = shortenPath(model.project.cwd, Math.max(16, innerWidth - 10));
	const branchText = model.project.branch ?? "none";
	const profilePart = model.project.profile
		? ` ${theme.fg("dim", "·")} ${theme.fg("muted", "Profile:")} ${theme.fg("text", model.project.profile)}`
		: "";
	const projectLines: string[] = [
		theme.fg("accent", theme.bold("[ PROJECT TARGET ACTIVE ]")),
		`  ${theme.fg("muted", "CWD:")} ${theme.fg("text", shortenedCwd)}`,
		`  ${theme.fg("muted", "Branch:")} ${theme.fg("text", branchText)}${profilePart}`,
		`  ${theme.fg("muted", "Diff:")} ${formatDiff(model.project.diff, theme)}`,
		...(model.project.diff.notice ? [`  ${theme.fg("warning", model.project.diff.notice)}`] : []),
	];

	// 2. [ MODEL CONTEXT PROTOCOL ]
	const mcpSummary = `  ${theme.fg("muted", "Servers:")} ${theme.fg("text", `${model.mcp.serverCount}/${model.mcp.totalServers}`)} ${theme.fg("dim", "·")} ${theme.fg("text", `${model.mcp.toolsCount} tools`)}`;
	const serverLines = model.mcp.servers.length > 0
		? model.mcp.servers.map((server) => formatServerStatus(server, theme))
		: [`  ${theme.fg("dim", "No MCP servers")}`];
	const mcpLines: string[] = [
		theme.fg("accent", theme.bold("[ MODEL CONTEXT PROTOCOL ]")),
		mcpSummary,
		...serverLines,
	];

	// 3. [ EXECUTION TELEMETRY ]
	const costAmount = model.telemetry.costTotal.toFixed(3);
	const costFormatted = model.telemetry.subscription ? `$${costAmount} sub` : `$${costAmount}`;
	const latencyFormatted = model.telemetry.latencyMs !== null ? `${model.telemetry.latencyMs}ms` : "--";
	const telemetryRow1 = `  ${theme.fg("muted", "Cost:")} ${theme.fg("text", costFormatted)} ${theme.fg("dim", "·")} ${theme.fg("muted", "Latency:")} ${theme.fg("text", latencyFormatted)}`;

	const percent = model.telemetry.contextPercent ?? (
		model.telemetry.contextTokens !== null && model.telemetry.contextWindow > 0
			? (model.telemetry.contextTokens / model.telemetry.contextWindow) * 100
			: null
	);
	const gauge = paintGauge(percent, theme);
	const tokensStr = model.telemetry.contextTokens !== null
		? `${formatTokens(model.telemetry.contextTokens)} / ${formatTokens(model.telemetry.contextWindow)}`
		: `-- / ${formatTokens(model.telemetry.contextWindow)}`;
	const percentStr = percent !== null ? `${Math.round(percent)}%` : "?%";
	const telemetryRow2 = `  ${theme.fg("muted", "Context:")} ${gauge} ${theme.fg("text", `${tokensStr} (${percentStr})`)}`;

	const telemetryLines: string[] = [
		theme.fg("accent", theme.bold("[ EXECUTION TELEMETRY ]")),
		telemetryRow1,
		telemetryRow2,
	];

	const body = [
		...projectLines,
		"",
		...mcpLines,
		"",
		...telemetryLines,
	];

	return renderCard(
		{
			title: "ENVIRONMENT HUD",
			body,
			tone: CARD_TONE.INFO,
		},
		theme,
		width,
		{ expanded: true },
	);
}

export function hudDigest(model: HudModel, visualSettings: unknown): string {
	return JSON.stringify([model, visualSettings]);
}

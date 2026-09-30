// Gentle Shell Environment HUD Card
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
	if (parts.length > 1) {
		const lastTwo = parts.slice(-2).join("/");
		const candidate2 = path.startsWith("/") ? `/…/${lastTwo}` : `…/${lastTwo}`;
		if (candidate2.length <= maxLen) return candidate2;
		const lastOne = parts[parts.length - 1]!;
		const candidate1 = path.startsWith("/") ? `/…/${lastOne}` : `…/${lastOne}`;
		if (candidate1.length <= maxLen) return candidate1;
		if (lastOne.length <= maxLen) return lastOne;
	}
	if (maxLen <= 1) return "…";
	return `…${path.slice(-(maxLen - 1))}`;
}

function formatDiffSummary(diff: HudProjectModel["diff"], theme: ShellBarTheme): string {
	const isClean = diff.clean || (diff.files === 0 && diff.added === 0 && diff.deleted === 0);
	if (isClean) {
		const text = diff.notice ? `clean (${diff.notice})` : "clean";
		return theme.fg("success", text);
	}
	const count = `${diff.files} ${diff.files === 1 ? "file" : "files"}`;
	const noticePart = diff.notice ? ` · ${diff.notice}` : "";
	return `${theme.fg("warning", `±${count}`)} ${theme.fg("dim", "(")}${theme.fg("success", `+${diff.added}`)} ${theme.fg("error", `−${diff.deleted}`)}${theme.fg("dim", ")")}${noticePart ? theme.fg("warning", noticePart) : ""}`;
}

function formatServerGlyph(server: HudMcpServerStatus, theme: ShellBarTheme): string {
	let icon: string;
	switch (server.status) {
		case "ready":
		case "connected":
			icon = theme.fg("success", "●");
			break;
		case "standby":
			icon = theme.fg("dim", "○");
			break;
		case "error":
			icon = theme.fg("error", "✖");
			break;
		default:
			icon = theme.fg("dim", "○");
			break;
	}
	return `${icon} ${theme.fg("text", server.name)}`;
}

export function renderHudCard(model: HudModel, theme: ShellBarTheme, width: number): string[] {
	const innerWidth = cardInnerWidth(width);

	// Fila 1 (Workspace CWD): CWD con todo el ancho disponible
	const shortenedCwd = shortenPath(model.project.cwd, innerWidth);
	const line1Raw = theme.fg("text", shortenedCwd);
	const line1 = truncateToWidth(line1Raw, innerWidth, "…");

	// Fila 2 (Branch, Perfil y Git Diff): ${branch} [${profile}] · ${diffSummary}
	const branchText = model.project.branch ?? "none";
	const profilePart = model.project.profile ? ` [${model.project.profile}]` : "";
	const diffPart = formatDiffSummary(model.project.diff, theme);
	const diffWidth = visibleWidth(diffPart);
	const fullTarget = `${theme.fg("text", branchText)}${model.project.profile ? theme.fg("muted", profilePart) : ""}`;
	const fullTargetWidth = visibleWidth(fullTarget);
	const availWithProfile = innerWidth - fullTargetWidth - diffWidth - 3;
	const targetPart = availWithProfile >= 0 ? fullTarget : theme.fg("text", branchText);
	const line2Raw = `${targetPart} ${theme.fg("dim", "·")} ${diffPart}`;
	const line2 = truncateToWidth(line2Raw, innerWidth, "…");

	// Fila 3 (MCP Ecosystem): MCP (${readyCount}/${total} · ${totalTools} tools) · ● name ○ name ✖ name
	const toolsCount = model.mcp.toolsCount;
	const mcpHead = `${theme.fg("muted", "MCP")} ${theme.fg("dim", "(")}${theme.fg("text", `${model.mcp.serverCount}/${model.mcp.totalServers}`)} ${theme.fg("dim", "·")} ${theme.fg("text", `${toolsCount} ${toolsCount === 1 ? "tool" : "tools"}`)}${theme.fg("dim", ")")}`;
	const serversList = model.mcp.servers.length > 0
		? model.mcp.servers.map((s) => formatServerGlyph(s, theme)).join(" ")
		: theme.fg("dim", "No MCP servers");
	const line3Raw = `${mcpHead} ${theme.fg("dim", "·")} ${serversList}`;
	const line3 = truncateToWidth(line3Raw, innerWidth, "…");

	// Fila 4 (Execution Telemetry): ${cost} (${latency}ms) · Ctx ${gauge} ${tokens} (${pct}%)
	const costAmount = model.telemetry.costTotal.toFixed(3);
	const costFormatted = model.telemetry.subscription ? `$${costAmount} sub` : `$${costAmount}`;
	const latencyFormatted = model.telemetry.latencyMs !== null ? `${model.telemetry.latencyMs}ms` : "--ms";

	const percent = model.telemetry.contextPercent ?? (
		model.telemetry.contextTokens !== null && model.telemetry.contextWindow > 0
			? (model.telemetry.contextTokens / model.telemetry.contextWindow) * 100
			: null
	);
	const gauge = paintGauge(percent, theme, 8);
	const tokensStr = model.telemetry.contextTokens !== null
		? `${formatTokens(model.telemetry.contextTokens)} / ${formatTokens(model.telemetry.contextWindow)}`
		: `-- / ${formatTokens(model.telemetry.contextWindow)}`;
	const percentStr = percent !== null ? `${Math.round(percent)}%` : "?%";

	const line4Raw = `${theme.fg("text", costFormatted)} ${theme.fg("dim", "(")}${theme.fg("muted", latencyFormatted)}${theme.fg("dim", ")")} ${theme.fg("dim", "·")} ${theme.fg("muted", "Ctx")} ${gauge} ${theme.fg("text", tokensStr)} ${theme.fg("dim", "(")}${theme.fg("text", percentStr)}${theme.fg("dim", ")")}`;
	const line4 = truncateToWidth(line4Raw, innerWidth, "…");

	return renderCard(
		{
			title: "ENVIRONMENT HUD",
			body: [line1, line2, line3, line4],
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

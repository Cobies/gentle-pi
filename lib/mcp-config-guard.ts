import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface McpConfigStatus {
	/** True if `mcp.json` exists and defines at least one server. */
	hasConfiguredServers: boolean;
	/** Number of servers configured in `mcp.json`. */
	serverCount: number;
	/** True if `settings.json` extensions array explicitly excludes `builtin:mcp` (e.g. `"-builtin:mcp"`). */
	isBuiltinMcpExcluded: boolean;
	/** Path to `settings.json`. */
	settingsPath: string;
	/** Path to `mcp.json`. */
	mcpPath: string;
}

/**
 * Inspects whether Pi built-in MCP is suppressed via settings.json while
 * mcp.json defines servers.
 */
export function inspectMcpConfigStatus(agentDir: string = getAgentDir()): McpConfigStatus {
	const settingsPath = join(agentDir, "settings.json");
	const mcpPath = join(agentDir, "mcp.json");

	let isBuiltinMcpExcluded = false;
	try {
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
			if (Array.isArray(settings?.extensions)) {
				isBuiltinMcpExcluded = settings.extensions.some(
					(e: unknown) => typeof e === "string" && e.replace(/^[+!]/, "") === "-builtin:mcp",
				);
			}
		}
	} catch {
		// Ignore parse errors; leave false
	}

	let serverCount = 0;
	try {
		if (existsSync(mcpPath)) {
			const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
			const servers = mcp?.mcpServers;
			if (servers && typeof servers === "object" && !Array.isArray(servers)) {
				serverCount = Object.keys(servers).length;
			}
		}
	} catch {
		// Ignore parse errors; leave 0
	}

	return {
		hasConfiguredServers: serverCount > 0,
		serverCount,
		isBuiltinMcpExcluded,
		settingsPath,
		mcpPath,
	};
}

/**
 * Removes `"-builtin:mcp"` from settings.json extensions array if present.
 * Returns true if the file was modified, false otherwise.
 */
export function removeBuiltinMcpExclusion(agentDir: string = getAgentDir()): boolean {
	const settingsPath = join(agentDir, "settings.json");
	try {
		if (!existsSync(settingsPath)) return false;
		const raw = readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw);
		if (!Array.isArray(settings?.extensions)) return false;

		const filtered = settings.extensions.filter(
			(e: unknown) => typeof e !== "string" || e.replace(/^[+!]/, "") !== "-builtin:mcp",
		);

		if (filtered.length === settings.extensions.length) return false;

		const indent = raw.match(/\{\r?\n([ \t]+)/)?.[1] ?? 2;
		const updated = JSON.stringify({ ...settings, extensions: filtered }, null, indent);
		writeFileSync(settingsPath, raw.endsWith("\n") ? `${updated}\n` : updated, "utf8");
		return true;
	} catch {
		return false;
	}
}

export interface McpServerSummary {
	configured: number;
	connected: number;
	isExcluded: boolean;
	statusText: string | undefined;
}

/**
 * Reads configured and enabled MCP server names across global and project configurations.
 */
export function readConfiguredMcpServerNames(agentDir: string = getAgentDir(), cwd?: string): Set<string> {
	const servers = new Set<string>();
	const paths = [join(agentDir, "mcp.json")];
	if (cwd) {
		paths.push(join(cwd, ".pi", "mcp.json"));
	}
	for (const p of paths) {
		try {
			if (existsSync(p)) {
				const data = JSON.parse(readFileSync(p, "utf8"));
				const mcpServers = data?.mcpServers;
				if (mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers)) {
					for (const [name, config] of Object.entries(mcpServers)) {
						if (config && typeof config === "object" && (config as { enabled?: boolean }).enabled === false) {
							servers.delete(name);
						} else {
							servers.add(name);
						}
					}
				}
			}
		} catch {
			// Ignore parse/read errors
		}
	}
	return servers;
}

/**
 * Extracts unique connected MCP server names from a list of tools.
 * Pi registers tools from MCP servers with names matching `mcp__<server>__<tool>`.
 */
export function extractConnectedMcpServerNames(tools: Array<{ name: string }>): Set<string> {
	const connected = new Set<string>();
	for (const tool of tools) {
		const match = /^mcp__(.+?)__/.exec(tool.name);
		if (match) {
			connected.add(match[1]);
		}
	}
	return connected;
}

/**
 * Computes MCP status summary and user-facing status line text.
 */
export function computeMcpStatus(options: {
	agentDir?: string;
	cwd?: string;
	tools?: Array<{ name: string }>;
} = {}): McpServerSummary {
	const agentDir = options.agentDir ?? getAgentDir();
	const configStatus = inspectMcpConfigStatus(agentDir);
	const configuredServers = readConfiguredMcpServerNames(agentDir, options.cwd);
	const configured = configuredServers.size;
	const connectedServers = extractConnectedMcpServerNames(options.tools ?? []);
	const connected = connectedServers.size;
	const isExcluded = configStatus.isBuiltinMcpExcluded;

	let statusText: string | undefined;
	if (isExcluded) {
		if (configured > 0) {
			statusText = "MCP: disabled";
		} else {
			statusText = undefined;
		}
	} else if (connected > 0) {
		if (configured > connected) {
			statusText = `MCP: ${connected}/${configured} servers`;
		} else {
			statusText = `MCP: ${connected} ${connected === 1 ? "server" : "servers"}`;
		}
	} else if (configured > 0) {
		statusText = `MCP: ${configured} ${configured === 1 ? "server" : "servers"}`;
	} else {
		statusText = undefined;
	}

	return {
		configured,
		connected,
		isExcluded,
		statusText,
	};
}


import { isDevelopmentSurface, WRITER_CONTEXT_BACKSTOP_TOKENS } from "./bounded-writer-admission.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const READ_THRASHING_THRESHOLD = 5;
export const EXPLORE_READ_BUDGET_THRESHOLD = 4;
export const TURN_TOOL_CALL_LIMIT = 25;
export const SUBAGENT_POLL_LIMIT = 2;

/**
 * Resolves current context tokens accurately, handling edge cases where
 * `ctx.getContextUsage()` returns null (e.g. post-compaction or unmeasured proxy models)
 * by falling back to the last recorded assistant message usage on the session branch.
 */
export function resolveCurrentContextTokens(ctx: {
	getContextUsage?: () => { tokens: number | null } | undefined;
	sessionManager?: { getBranch?: () => Array<{ type: string; message?: unknown }> };
}): number | undefined {
	const usageTokens = ctx.getContextUsage?.()?.tokens;
	if (typeof usageTokens === "number" && usageTokens > 0) {
		return usageTokens;
	}
	try {
		const branch = ctx.sessionManager?.getBranch?.();
		if (Array.isArray(branch)) {
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry && entry.type === "message" && entry.message && typeof entry.message === "object") {
					const msg = entry.message as {
						role?: string;
						usage?: { totalTokens?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
					};
					if (msg.role === "assistant" && msg.usage) {
						const total =
							msg.usage.totalTokens ||
							((msg.usage.input ?? 0) + (msg.usage.output ?? 0) + (msg.usage.cacheRead ?? 0) + (msg.usage.cacheWrite ?? 0));
						if (total > 0) return total;
					}
				}
			}
		}
	} catch {
		// safe fallback
	}
	return undefined;
}

/**
 * Rejects direct inline code mutations (edit/write) when the primary session's
 * context usage reaches or exceeds the context backstop (150,000 tokens).
 *
 * This enforces Rule 7 of ODD orchestration: once the context passes 150k tokens,
 * the orchestrator must delegate bounded units to gentle-ai-worker rather than
 * inflating context further with monolithic inline edits.
 *
 * Non-development surfaces (such as odd/tasks/*.md, TODO.md, README.md, docs)
 * remain permitted so the orchestrator can update tracking artifacts.
 */
export function rejectContextBackstopInlineMutation(
	event: { toolName: string; input: unknown },
	options: { contextTokens: number | null | undefined },
): { block: true; reason: string } | undefined {
	if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
	if (typeof options.contextTokens !== "number" || options.contextTokens < WRITER_CONTEXT_BACKSTOP_TOKENS) return undefined;
	if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;
	if (!isDevelopmentSurface(event.input.path)) return undefined;
	return {
		block: true,
		reason: `Context backstop reached (${options.contextTokens.toLocaleString()} tokens >= ${WRITER_CONTEXT_BACKSTOP_TOKENS.toLocaleString()}). Direct inline code mutations are locked to protect orchestrator reasoning fidelity. You must delegate this unit of work to gentle-ai-worker with declared ## Allowed edit surfaces, or pause and summarize your progress.`,
	};
}

/**
 * Enforces the ODD Evidence-budget rule:
 * "understanding needs more than one read batch or >~5 sequential lookups -> one gentle-ai-explore".
 *
 * If the primary orchestrator accumulates more than 5 read lookups across the codebase
 * in a turn without having modified files or dispatched an explore subagent, the runtime
 * halts further inline reading and forces delegating the exploration to gentle-ai-explore.
 */
export class EvidenceBudgetGuard {
	private distinctReads = new Set<string>();
	private totalReads = 0;

	checkRead(event: { toolName: string; input: unknown }): { block: true; reason: string } | undefined {
		return this.checkExploration(event);
	}

	checkExploration(event: { toolName: string; input: unknown }): { block: true; reason: string } | undefined {
		// Handle read tool calls
		if (event.toolName === "read") {
			if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;

			const normalized = event.input.path.replace(/\\/g, "/");
			// Ignore reading tracking/odd tasks, documentation, non-development surfaces, or tests
			if (
				normalized.startsWith("odd/") ||
				normalized.startsWith("docs/") ||
				normalized.endsWith(".md") ||
				!isDevelopmentSurface(normalized) ||
				/(?:^|\/)(?:tests?|__tests?__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
			) {
				return undefined;
			}

			this.distinctReads.add(normalized);
			this.totalReads += 1;
		} else if (event.toolName === "read_symbol" || event.toolName === "read_enclosing") {
			if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;
			const normalized = event.input.path.replace(/\\/g, "/");
			if (
				normalized.startsWith("odd/") ||
				normalized.startsWith("docs/") ||
				normalized.endsWith(".md") ||
				!isDevelopmentSurface(normalized) ||
				/(?:^|\/)(?:tests?|__tests?__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized)
			) {
				return undefined;
			}
			this.distinctReads.add(normalized);
			this.totalReads += 1;
		} else if (event.toolName === "symbol_search") {
			if (!isRecord(event.input) || typeof event.input.query !== "string") return undefined;
			this.distinctReads.add(`symbol_search:${event.input.query.slice(0, 40)}`);
			this.totalReads += 1;
		} else if (event.toolName === "grep") {
			if (!isRecord(event.input)) return undefined;
			const targetPath = typeof event.input.path === "string" ? event.input.path.replace(/\\/g, "/") : "";
			if (targetPath.startsWith("odd/") || targetPath.startsWith("docs/") || targetPath.endsWith(".md")) {
				return undefined;
			}
			const pattern = typeof event.input.pattern === "string" ? event.input.pattern : "grep";
			this.distinctReads.add(`grep:${pattern}:${targetPath}`);
			this.totalReads += 1;
		} else if (event.toolName === "find") {
			if (!isRecord(event.input)) return undefined;
			const targetPath = typeof event.input.path === "string" ? event.input.path.replace(/\\/g, "/") : "";
			if (targetPath.startsWith("odd/") || targetPath.startsWith("docs/")) return undefined;
			const pattern = typeof event.input.pattern === "string" ? event.input.pattern : "find";
			this.distinctReads.add(`find:${pattern}:${targetPath}`);
			this.totalReads += 1;
		} else if (event.toolName === "ls") {
			if (!isRecord(event.input)) return undefined;
			const targetPath = typeof event.input.path === "string" ? event.input.path.replace(/\\/g, "/") : ".";
			if (targetPath.startsWith("odd/") || targetPath.startsWith("docs/")) return undefined;
			this.distinctReads.add(`ls:${targetPath}`);
			this.totalReads += 1;
		} else if (event.toolName === "bash") {
			if (!isRecord(event.input) || typeof event.input.command !== "string") return undefined;
			const cmd = event.input.command.trim();

			// Intercept internal session JSONL or temp edit artifacts introspection loops
			if (/(?:\.pi\/agent\/sessions|\/tmp\/edit_[\w.-]+\.json)/.test(cmd)) {
				return {
					block: true,
					reason: `Session introspection blocked: Do not inspect internal session JSONL or temp edit artifacts via bash. Focus on the requested task or delegate to gentle-ai-explore or gentle-ai-worker.`,
				};
			}

			// Intercept shell-based code searches (git grep, git log, git show, git diff, cat, sed -n)
			if (/\b(?:git\s+(?:grep|log|show|diff)|grep\s+|find\s+|cat\s+|sed\s+-n)\b/.test(cmd) && !/\b(?:odd\/|docs\/|\.md\b)/.test(cmd)) {
				this.distinctReads.add(`bash:${cmd.slice(0, 45)}`);
				this.totalReads += 1;
			} else {
				return undefined;
			}
		} else {
			return undefined;
		}

		if (this.distinctReads.size > EXPLORE_READ_BUDGET_THRESHOLD || this.totalReads > EXPLORE_READ_BUDGET_THRESHOLD + 2) {
			return {
				block: true,
				reason: `Evidence-budget rule triggered: You have performed ${this.totalReads} sequential exploration lookups across ${this.distinctReads.size} sources inline. Codebase exploration across multiple files MUST be delegated to gentle-ai-explore to protect parent reasoning context. Stop inline reading/searching and delegate exploration now.`,
			};
		}
		return undefined;
	}

	recordDelegation(): void {
		this.reset();
	}

	recordMutation(_path?: string): void {
		this.reset();
	}

	/**
	 * Preserves the evidence budget across assistant turns/iterations in an agent run.
	 * Sequential lookups across multiple iterations count toward the evidence budget
	 * until the agent mutates a file (implementation) or delegates (subagent dispatch).
	 */
	resetTurn(): void {
		// Intentionally a no-op: evidence budget accumulates across sequential turns.
	}

	reset(): void {
		this.distinctReads.clear();
		this.totalReads = 0;
	}
}

/**
 * Tracks micro-fragmented reads on the same file in a single turn without modifications.
 * Prevents "read thrashing" / analysis paralysis loops where an agent performs dozens
 * of incremental offset reads on a file instead of reading completely or delegating.
 */
export class ReadThrashingGuard {
	private readCounts = new Map<string, number>();

	checkRead(event: { toolName: string; input: unknown }): { block: true; reason: string } | undefined {
		if (event.toolName !== "read") return undefined;
		if (!isRecord(event.input) || typeof event.input.path !== "string") return undefined;

		// A micro-fragmented read is one with an explicit offset (> 1) and small limit (<= 200 lines).
		const isMicroFragmented =
			typeof event.input.offset === "number" &&
			event.input.offset > 1 &&
			typeof event.input.limit === "number" &&
			event.input.limit <= 200;

		const normalized = event.input.path.replace(/\\/g, "/");
		const current = (this.readCounts.get(normalized) ?? 0) + (isMicroFragmented ? 1 : 0.5);
		this.readCounts.set(normalized, current);

		if (current >= READ_THRASHING_THRESHOLD) {
			return {
				block: true,
				reason: `Read thrashing detected: "${normalized}" has been read incrementally ${Math.floor(current)} times without modification. Incremental offset reads degrade context and indicate analysis paralysis. Read the required symbol or range completely in one call, or delegate this task to gentle-ai-explore or gentle-ai-worker.`,
			};
		}
		return undefined;
	}

	recordMutation(path: string): void {
		const normalized = path.replace(/\\/g, "/");
		this.readCounts.delete(normalized);
	}

	resetTurn(): void {
		this.reset();
	}

	reset(): void {
		this.readCounts.clear();
	}
}

/**
 * Protects against runaway turns where an orchestrator runs an excessive number
 * of tool calls (25+) in a single turn without delegating or summarizing.
 */
export class TurnToolCallGuard {
	private callCount = 0;
	private budgetExceeded = false;

	checkCall(event: { toolName: string; input?: unknown }): { block: true; reason: string } | undefined {
		// Meta-tools and memory bookkeeping do not count towards runaway inline execution.
		if (
			event.toolName === "todo" ||
			event.toolName === "gentle_odd_phase" ||
			event.toolName === "orchestrator_session_id" ||
			event.toolName === "subagent_run" ||
			event.toolName.startsWith("mem_")
		) {
			return undefined;
		}

		// Editing non-development tracking surfaces (odd/tasks/*.md, docs, etc.) is bookkeeping.
		if (
			(event.toolName === "write" || event.toolName === "edit") &&
			isRecord(event.input) &&
			typeof event.input.path === "string" &&
			!isDevelopmentSurface(event.input.path)
		) {
			return undefined;
		}

		this.callCount += 1;
		if (this.callCount > TURN_TOOL_CALL_LIMIT) {
			this.budgetExceeded = true;
			return {
				block: true,
				reason: `Turn tool budget exceeded (${TURN_TOOL_CALL_LIMIT} tool calls in a single turn without delegation). Consolidate your progress in todo, summarize the outcome for the user, or delegate the next unit of work to a subagent (gentle-ai-explore or gentle-ai-worker).`,
			};
		}
		return undefined;
	}

	isBudgetExceeded(): boolean {
		return this.budgetExceeded || this.callCount > TURN_TOOL_CALL_LIMIT;
	}

	recordDelegation(): void {
		this.callCount = 0;
		this.budgetExceeded = false;
	}

	resetTurn(): void {
		this.callCount = 0;
	}

	reset(): void {
		this.callCount = 0;
		this.budgetExceeded = false;
	}
}

/**
 * Bounds reactive polling loops where the parent orchestrator repeatedly checks
 * subagent_status or subagent_result in the same turn instead of waiting for
 * the background completion notification event.
 */
export class SubagentPollingGuard {
	private pollCount = 0;

	checkPoll(event: { toolName: string; input?: unknown }): { block: true; reason: string } | undefined {
		if (event.toolName !== "subagent_status" && event.toolName !== "subagent_result") {
			return undefined;
		}
		this.pollCount += 1;
		if (this.pollCount > SUBAGENT_POLL_LIMIT) {
			return {
				block: true,
				reason: `Subagent polling blocked: Do not poll subagent_status or subagent_result in a tight loop (${this.pollCount} calls this turn). End your turn and wait for the completion notification event, or launch subagents with mode: "task" for synchronous delegation.`,
			};
		}
		return undefined;
	}

	resetTurn(): void {
		this.pollCount = 0;
	}

	recordDelegation(): void {
		this.pollCount = 0;
	}

	reset(): void {
		this.pollCount = 0;
	}
}

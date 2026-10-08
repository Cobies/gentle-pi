# Enforce Worker Dispatch Consent Gate

## 1. Diagnosis & Technical Proposal

### Problem Statement
The orchestrator prompt instructions mandate that *"all source code mutations, edits, and multi-file work MUST delegate to gentle-ai-worker and require explicit user permission before dispatch"*.
However, in `extensions/gentle-ai.ts`, the runtime hook `tool_call` only checks that `## Allowed edit surfaces` are syntactically present when calling `subagent_run` (`rejectUnscopedBoundedWriterDispatch`). It does not intercept the dispatch to require interactive human consent before launching bounded writers (`gentle-ai-worker`, `worker`, `jd-fix-agent`). Consequently, orchestrator models often launch writer subagents autonomously without waiting for explicit user confirmation.

### Technical Proposal
- In `extensions/gentle-ai.ts` (or a helper in `lib/`), add a runtime gate in `pi.on("tool_call")` for `subagent_run` targeting `BOUNDED_WRITER_AGENT_NAMES`.
- In an interactive session with UI (`ctx.hasUI && typeof ctx.ui.confirm === "function"`), display a confirmation modal (`ctx.ui.confirm`) asking the user for authorization to launch the worker subagent, displaying the agent name, label, task summary, and declared edit surfaces.
- If the user declines, or if the interactive confirmation returns false, block the tool call with `{ block: true, reason: "Gentle AI safety policy: dispatch of bounded writer subagent was declined or not authorized by the user." }`.
- If non-interactive without UI (`!ctx.hasUI`), ensure appropriate handling.
- Cover this with automated tests in `tests/subagent-guardrails.test.ts`.

## 2. Technical Specification & Contracts

- **Tool Call Interception:**
  When `event.toolName === "subagent_run"` and `BOUNDED_WRITER_AGENT_NAMES.includes(input.agent)`:
  1. Validate edit surfaces (existing `rejectUnscopedBoundedWriterDispatch`).
  2. If valid, check interactive confirmation via `confirmBoundedWriterDispatch(input, ctx)`.
  3. Prompt title: `Authorize worker subagent dispatch`
  4. Prompt message: Includes agent name, label, and list of target edit surfaces.
  5. If user confirms (`true`), dispatch proceeds; otherwise returns `{ block: true, reason: ... }`.

## 3. Tasks & Evidence

- [ ] **T1 — Write failing test (RED) in `tests/subagent-guardrails.test.ts`**
- [ ] **T2 — Implement `confirmBoundedWriterDispatch` in `extensions/gentle-ai.ts` (GREEN)**
- [ ] **T3 — Verify test suite passes with zero regressions**
- [ ] **T4 — Work-unit commit on branch `feat/hybrid-odd-specification`**

## 4. Acceptance Criteria & Verification

- `subagent_run` with `gentle-ai-worker` in interactive mode triggers `ctx.ui.confirm`.
- Declining confirmation blocks the tool call and returns a descriptive refusal reason.
- Confirming allows the tool call to proceed normally.
- Non-writer subagents (e.g., `gentle-ai-explore`, `sdd-explore`) do not trigger the prompt and continue freely.

# Feature: Enforce Subagent Runtime Guardrails and Turn-Yield

## 1. Diagnosis & Technical Proposal

### Diagnosis
1. **Background Polling Defect**: When the orchestrator launches background subagents, models frequently fail to yield turns (`turn-yield`) and enter active polling loops using `subagent_status` or `subagent_result`. While `extensions/gentle-ai.ts` intercepts `sleep` commands in `bash`, it lacks runtime interception for `subagent_status` and `subagent_result` when called on tasks that are still active (`running` or `queued`). Models ignore the prose warning in the tool description because the tool call succeeds and returns output, prompting the LLM to continue querying.
2. **Inline Execution Defect**: Despite strict prompt instructions declaring the orchestrator a Pure Thinker, the orchestrator toolbelt allows unrestricted `write` and `edit` calls. The runtime only observes mutations in `tool_result` to notify RDD, but never intercepts or blocks direct code writes in `tool_call`. Consequently, orchestrator sessions drift into editing codebase files inline instead of delegating to `gentle-ai-worker`.

### Technical Proposal
1. **Runtime Polling Guardrail in `tool_call`**:
   - In `extensions/gentle-agents.ts` or `extensions/gentle-ai.ts`, intercept `tool_call` events for `subagent_status` and `subagent_result`.
   - If the target task is `running` or `queued`, block execution before calling the tool handler:
     ```ts
     {
       block: true,
       reason: "Gentle AI safety policy: polling subagent_status or subagent_result while a background task is running is strictly forbidden. Results arrive automatically via session message when settled. You MUST end your turn immediately without calling further tools."
     }
     ```
2. **Runtime Code Mutation Guardrail in `tool_call`**:
   - In `extensions/gentle-ai.ts`, intercept `tool_call` for `write` and `edit` in the primary orchestrator session (`!env.GENTLE_PI_AGENTS_CHILD`).
   - Allow internal tracking/bookkeeping paths: `odd/tasks/**`, `.atl/**`, `.pi/**`, `.git/**`, temporary directories, or `.engram/**`.
   - Block any source code or project file edits with a mandatory delegation refusal directing the orchestrator to dispatch `gentle-ai-worker` with `## Allowed edit surfaces`.
   - Exempt child subagent processes (`GENTLE_PI_AGENTS_CHILD === "1"`) so workers can perform authorized edits.
3. **Prompt & Tool Description Hardening**:
   - Update descriptions in `extensions/gentle-agents.ts` for `subagent_status` and `subagent_result` stating that active tasks will be rejected by runtime policy.
   - Update `assets/orchestrator-delegation.md` with runtime gate details.

---

## 2. Technical Specification & Contracts

### Allowed & Blocked Surfaces for Orchestrator Mutations
- **Allowed inline paths for primary orchestrator**:
  - `odd/tasks/**` (feature task definitions and progress updates)
  - `.atl/**` (skills and local registries)
  - `.pi/**` (session configuration and UI state)
  - Ephemeral scratch/temp files (`/tmp/**` or OS tempdir)
- **Blocked paths for primary orchestrator**:
  - Any project source code files (e.g. `src/**`, `lib/**`, `extensions/**`, `assets/**`, `tests/**`, root package files like `package.json`, etc.)
- **Exemptions**:
  - Subagent workers (`GENTLE_PI_AGENTS_CHILD === "1"` or named worker subagents).

### Polling Interception Contract
- Tool names: `subagent_status`, `subagent_result`.
- Trigger condition: Target task exists and status is in `["queued", "running"]`.
- Intercept action: Return `{ block: true, reason: string }` on `pi.on("tool_call")`.

---

## 3. Tasks & Evidence

- [x] Task 1: Implement background task anti-polling guardrail in `extensions/gentle-agents.ts` (intercept `subagent_status` and `subagent_result` in `tool_call` when task is active).
  - *Evidence*: Intercepted `subagent_status` and `subagent_result` in `pi.on("tool_call")` inside `extensions/gentle-agents.ts` when resolved task is `running` or `queued`, returning `{ block: true, reason: ... }`. Verified in `tests/subagent-guardrails.test.ts`.
- [x] Task 2: Implement orchestrator inline code mutation guardrail in `extensions/gentle-ai.ts` (intercept `write` and `edit` on non-tracking project files for primary orchestrator).
  - *Evidence*: Added `isAllowedOrchestratorMutationPath` and `tool_call` interception in `extensions/gentle-ai.ts` blocking primary orchestrator `write`/`edit` on codebase files while allowing `odd/tasks/**`, `.atl/**`, `.pi/**`, `.git/**`, `.engram/**`, and temporary directories, and exempting child/named subagents. Verified in `tests/subagent-guardrails.test.ts`.
- [x] Task 3: Update tool descriptions and prompt assets (`assets/orchestrator-delegation.md`, `extensions/gentle-agents.ts`).
  - *Evidence*: Updated `subagent_status` and `subagent_result` tool descriptions in `extensions/gentle-agents.ts` and documented both runtime guardrails in `assets/orchestrator-delegation.md`. Verified anchor preservation in `tests/odd-routing-canonical-ratchet.test.ts`.
- [x] Task 4: Add end-to-end tests for runtime guardrails in `tests/subagent-guardrails.test.ts`.
  - *Evidence*: `node --experimental-strip-types --test tests/subagent-guardrails.test.ts` (3/3 passed), `tests/gentle-agents.test.ts` (120/120 passed), `tests/gentle-ai.test.ts` (81/81 passed), `tests/odd-runtime-delegation-gate.test.ts` (1/1 passed), `tests/odd-routing-canonical-ratchet.test.ts` (7/7 passed).

---

## 4. Acceptance Criteria & Verification

1. Calling `subagent_status` or `subagent_result` for an in-flight background task returns `{ block: true, reason: ... }`.
2. Primary orchestrator calling `edit` or `write` on `src/index.ts` or `extensions/gentle-ai.ts` returns `{ block: true, reason: ... }`.
3. Primary orchestrator calling `edit` or `write` on `odd/tasks/feature.md` or `.pi/config.json` succeeds without blockage.
4. Child subagent (`GENTLE_PI_AGENTS_CHILD="1"`) can freely call `edit` and `write` within its assigned scope.
5. All test suites in `gentle-pi` pass.

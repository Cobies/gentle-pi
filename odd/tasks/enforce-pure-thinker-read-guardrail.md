# Feature: Enforce Pure Thinker Read Guardrail in Orchestrator

## 1. Diagnosis & Technical Proposal

### Diagnosis
1. **Unchecked Code Reading in Primary Orchestrator**: The system prompt instructs that the primary orchestrator is a Pure Thinker and Coordinator, capping inline code reads at 2 files and requiring delegation to `gentle-ai-explore` for cross-file inspection or 3+ reads. However, in `extensions/gentle-ai.ts`, the `tool_call` hook only intercepts `write`, `edit`, and `subagent_run` (and `sleep` in `bash`). There is zero runtime interception for `read`.
2. **Context Inflation and Protocol Drift**: In long sessions or with large-context models (1M+ tokens), models ignore prompt-only soft constraints and repeatedly call `read` on source code files inline, bypassing `gentle-ai-explore`. This inflates orchestrator context, wastes tokens, and breaks the pure thinker role contract.

### Technical Proposal
1. **Turn-Scoped Code Read Counter in `extensions/gentle-ai.ts`**:
   - Maintain a per-session or turn-scoped counter of source code reads by the primary orchestrator (`!isChild`).
   - Reset the counter on every user turn (`turn_start` or turn initialization event) or per-prompt lifecycle.
2. **Exclusion / Allowlist for Non-Source Paths**:
   - Do NOT count or block reads to:
     - Feature task tracking: `odd/tasks/**`
     - Skill files and registry: `.atl/**`, `skills/**`, `AGENTS.md`, `CLAUDE.md`, `SKILL.md`
     - Orchestrator configuration / state: `.pi/**`, `.git/**`, `.engram/**`
     - Package manifests and config: `package.json`, `tsconfig.json`, `pnpm-lock.yaml`, `go.mod`, `go.sum`, etc.
     - Ephemeral / temp files: `/tmp/**`, OS temp directory
     - Markdown docs: `*.md`
3. **Hard Cap on Source Code Reads**:
   - When a read targets a codebase source file (e.g. `src/**`, `lib/**`, `extensions/**`, or files ending in `.ts`, `.js`, `.go`, `.py`, `.rs`, `.c`, `.cpp`, `.java`, etc.):
     - Reads 1 and 2: Allowed (to give the orchestrator minimal inline context for simple clarification).
     - Read 3 and above: Intercept in `tool_call` and return:
       ```ts
       {
         block: true,
         reason: "Gentle AI Pure Thinker policy: inline code read cap exceeded (max 2 source files per turn). You MUST delegate codebase exploration to gentle-ai-explore to preserve orchestrator context (<20k tokens)."
       }
       ```
4. **Subagent Exemption**:
   - Child processes (`processEnv.GENTLE_PI_AGENTS_CHILD === "1"`), active subagents, and named worker/explorer contexts are completely exempt from the read limit.

---

## 2. Technical Specification & Contracts

### Path Classification
- **Allowlist (No limit, 0 quota consumed)**:
  - Paths matching `odd/tasks/**`, `.atl/**`, `.pi/**`, `.git/**`, `.engram/**`, `/tmp/**`.
  - Documentation files: `*.md`.
  - Root config files: `package.json`, `tsconfig.json`, `go.mod`, `go.sum`, `pnpm-lock.yaml`, `package-lock.json`, `.gitignore`.
- **Source Code Paths (Consumes turn read quota)**:
  - Any file in `src/`, `lib/`, `extensions/`, `cmd/`, `internal/`, `test/`, `tests/` or with code extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.go`, `.py`, `.rs`, etc.) not in the allowlist.

### Interception Contract
- Tool: `read`
- Condition: Primary orchestrator (`!isChild`), source file, turn code read count >= 2.
- Action: Return `{ block: true, reason: string }`.

---

## 3. Tasks & Evidence

- [x] Task 1: Add unit tests for Pure Thinker read guardrail in `tests/subagent-guardrails.test.ts`.
  - Evidence: Added 5 test suites covering primary orchestrator 2-read cap, 3rd read blocking, allowlist bypassing, turn_start resetting, child subagent exemptions, and `isCodeSourcePath` classification.
- [x] Task 2: Implement read counter, path classifier, and `tool_call` interception in `extensions/gentle-ai.ts`.
  - Evidence: Added `isCodeSourcePath` helper with allowlists and code-source heuristics, turn-scoped code read counter per session, `turn_start` hook reset, `session_shutdown` cleanup, and `tool_call` interception returning the Pure Thinker cap notice.
- [x] Task 3: Verify all test cases pass in `tests/subagent-guardrails.test.ts`.
  - Evidence: `node --experimental-strip-types --test tests/subagent-guardrails.test.ts` passed (9 tests, 0 failures).

---

## 4. Acceptance Criteria & Verification

1. Primary orchestrator can read up to 2 source code files in a turn without blockage.
2. 3rd source code read in the same turn by the primary orchestrator returns `{ block: true, reason: ... }`.
3. Reading `odd/tasks/foo.md`, `package.json`, `.atl/...` does NOT increment the code read counter or block.
4. Child subagents (`GENTLE_PI_AGENTS_CHILD = "1"`) can read unlimited source code files.
5. `tests/subagent-guardrails.test.ts` passes with all assertions verified.

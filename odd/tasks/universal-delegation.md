# Feature: Universal Delegation Default

Enable delegation by default for both exploration (`gentle-ai-explore`) and implementation (`gentle-ai-worker`).

## Specs

- S1: "ahora la regla sera que todo se delega tanto el explorer como el worker" — delegating exploration and implementation is the default execution topology; the parent does not execute multi-step exploration or code edits inline.
- S2: `rejectUndocumentedWriterLaunch` in `lib/bounded-writer-admission.ts` must allow bounded writer dispatches by default, without blocking when an ODD feature document task reference is absent, while still enforcing scoped `## Allowed edit surfaces`.
- S3: Orchestration prompt assets (`assets/orchestrator.md`, `assets/orchestrator-delegation.md`, `assets/orchestrator-delegation-reference.md`, `assets/orchestrator-writer.md`) must prescribe delegation by default for exploration and implementation.
- S4: All related unit tests and contract tests pass.

## Tasks

- [x] T1 (linked S2): Update `lib/bounded-writer-admission.ts` to permit bounded writer launches by default.
- [x] T2 (linked S3): Update prompt assets (`assets/orchestrator*.md`) to reflect the universal delegation rule.
- [x] T3 (linked S4): Update and verify tests in `tests/` covering delegation admission and contracts.

## Log

- L1: User requested permanent change: "debe ser d eforma permanente en gentle-pi revisa exaustivamente que no te saltes nada y hazlo" (now the rule is that everything is delegated, both explorer and worker).
- L2: Completed implementation of universal delegation default in `lib/bounded-writer-admission.ts`, updated prompt assets in `assets/orchestrator-writer.md`, and aligned unit tests in `tests/writer-feature-document-admission.test.ts`. All 50 admission tests and 17 writer surface tests pass.

# Orchestrator — Writer Handoff (lazy-loaded)

Parent Pi session only. Load it when the Writer rule fires or an explicitly activated Judgment Day fix batch is dispatched; small tasks never need it. The Writer rule fires on a named reason (bounded units of a large feature with declared edit surfaces, parallel units, the context backstop), never on size alone or a price ratio: small tasks without a reason stay inline. Configured per-agent models (`subagents.json` `model_profiles`) still apply to every writer it launches. Each writer prompt requires the self-review of the Parallel review protocol in `orchestrator-verification.md`. A reason holds only when the launch delivers it:

- **Bounded units**: for an authorized task of a large feature, derive nonempty `## Allowed edit surfaces` and launch one bounded writer (`gentle-ai-worker`, a user-configured `worker`, or the native `Agent` fallback), keeping the parent as a thin coordinator.
- **Parallelism**: with the Background subagent policy on, launch every disjoint unit in the same turn via `subagent_run` with `mode: "background"`, then wait for all completions before the Seam check; serial launches void the reason: if units cannot launch together, work inline.

#### Allowed edit surfaces (MANDATORY)

The bounded writer refuses to write outside the exact allowed edit surfaces and stops with `status: interaction_required` when they are missing. The parent derives them while planning the delegation; neither the writer nor the human supplies them.

Before launching a bounded writer (`gentle-ai-worker`, a user-configured `worker`, or the native `Agent` fallback), derive the allowed edit surface from the delegated task — files the change must touch, plus directories where it authorizes new files — and pass it in the prompt under an `## Allowed edit surfaces` heading, in the exact-path form of `## Skills to load before work`:

- exact repository-relative paths or narrow globs, one per line; never `.` and never a bare repository root; paths with whitespace require whole-entry backticks (for example, ``- `Directory With Spaces/note.md` ``);
- the section ends only at the next canonical ATX Markdown heading of any level (0-3 leading spaces, 1-6 `#`, then a space); every non-empty line before that heading must be a valid surface entry;
- pre-existing untracked targets the writer may write, listed explicitly;
- nothing beyond the delegated task — a surface wider than the task is the same defect as no surface at all.

If the surface genuinely cannot be derived, do not launch the writer or ask the human to author paths. Derive a candidate set first and present that list as an approve/decline choice under Lossless Blocking Prompts in `orchestrator-prompts.md`. A free-text question asking which paths to authorize is never valid: computing it is the parent's job.

Relay a writer's `interaction_required` payload about edit surfaces the same way: present candidate paths as the choice, and add or drop paths only on human instruction.

#### Judgment Day fix dispatch

Use `jd-fix-agent` only for an explicitly activated Judgment Day fix batch, never as a lexical or generic-writer fallback. Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent. A standalone Judgment Day fix requires no graph-v1 or native review lineage. Its dispatch carries this exact runtime-accepted Markdown shape: `## Judgment Day activation` contains only `User explicitly requested Judgment Day.`. Replace the example ID, frozen ledger hash, row data, and surface with controller-authorized values. The correction batch contains only one round (`1 of 2` or `2 of 2`) and one lowercase SHA-256. The exact frozen finding rows are one JSON object per line, use only the canonical row fields, and exactly match the authorized IDs.

```markdown
## Judgment Day activation
User explicitly requested Judgment Day.
## Exact authorized severe IDs
- `JD-A-001`
## Judgment Day correction batch
Round: 1 of 2.
Frozen ledger SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
## Exact frozen finding rows
{"id":"JD-A-001","lens":"judgment-day","location":"path/to/authorized-file.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"Concrete user-impact claim supported by the frozen location."}
## Allowed edit surfaces
path/to/authorized-file.ts
```

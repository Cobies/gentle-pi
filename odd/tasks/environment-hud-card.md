# Feature: Environment HUD Card in Fullscreen Sidebar

## 1. Diagnosis & Technical Proposal

### Context & Diagnosis
The Gentle Shell currently displays system telemetry and session details spread across the header row, bottom footer, and separate widgets. In fullscreen mode on wide terminals ($\ge 140$ columns), the right rail layout (`lib/shell-sidebar-layout.ts`) hosts sections like `todo` and `changes`, but lacks a unified, high-density environment telemetry HUD showing active project target status, connected MCP servers/tools, and runtime execution metrics (session cost, model latency, context window gauge).

### Technical Proposal
Introduce an `ENVIRONMENT HUD` card at the top of the fullscreen sidebar rail in `gentle-pi`:
- Card framework: Rendered via `renderCard` with `CARD_TONE.INFO` and structured into 3 distinct visual sections:
  1. `[ PROJECT TARGET ACTIVE ]`: CWD (shortened), current Git branch, active profile, and working-tree dirty status (`clean` or `±N files · +X −Y`).
  2. `[ MODEL CONTEXT PROTOCOL ]`: Connected servers count, individual status list, and active tools tally.
  3. `[ EXECUTION TELEMETRY ]`: Session cost ($X.XXX), last LLM turn latency (`ms`), and context window gauge (`paintGauge` with tokens used / window size).
- Differential Caching: Implement `hudDigest(model, settings): string` to allow the sidebar's `sectionCache` to skip rendering unless target, MCP, or telemetry values change.
- Extension Integration: Wire into `extensions/gentle-shell.ts` through `sidebarPart(tui, "hud", ...)`, capturing turn latency via `before_provider_request` / `turn_end` and reading MCP state from Pi tool metadata and extension statuses.

## 2. Technical Specification & Contracts

### Component Contracts (`lib/shell-hud.ts`)

```ts
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

export function renderHudCard(model: HudModel, theme: ShellBarTheme, width: number): string[];
export function hudDigest(model: HudModel, visualSettings: unknown): string;
```

### Layout Integration (`lib/shell-sidebar-layout.ts`)
- Support `"hud"` in `state.parts`.
- In fullscreen rail rendering, place `"hud"` at the top of the rail components list before `"changes"`, `"footer"`, and `"todo"`.

## 3. Tasks & Evidence

- [x] T1 — Unit Tests & HUD Model: Implement `tests/shell-hud.test.ts` covering model formatting, rendering of the 3 modules, truncation in bounded width, and deterministic `hudDigest`.
  - Evidence: `node --experimental-strip-types --test tests/shell-hud.test.ts` passed 6/6 tests covering frame/title/modules, clean/dirty diffs, MCP servers and tools, telemetry (cost, latency, gauge, tokens), bounded widths, and `hudDigest` mutation detection.
- [x] T2 — HUD Component Implementation: Implement `lib/shell-hud.ts` (`renderHudCard`, `hudDigest`, section formatters) matching visual reference.
  - Evidence: Exported `HudProjectModel`, `HudMcpServerStatus`, `HudMcpModel`, `HudTelemetryModel`, `HudModel`, `renderHudCard`, and `hudDigest`. Rendered using `renderCard` with `CARD_TONE.INFO` and structured across the 3 visual modules.
- [x] T3 — Rail Layout Ordering: Update `lib/shell-sidebar-layout.ts` and `tests/shell-sidebar-layout.test.ts` to order `"hud"` as a top-level rail section with differential cache support.
  - Evidence: Updated rail section ordering in `lib/shell-sidebar-layout.ts` to place `"hud"` first. Added unit tests in `tests/shell-sidebar-layout.test.ts` verifying `"hud"` renders at the top of the rail before footer/todo and that `"hud"` digest mutations invalidate only the hud section while keeping sibling sections cached.
- [x] T4 — Shell Extension Wiring & Metrics: Update `extensions/gentle-shell.ts` to track latency, aggregate MCP statuses and context telemetry, and mount the HUD via `sidebarPart(tui, "hud", ...)`.
  - Evidence: Integrated `buildHudMcpModel`, LLM turn latency measurement on `before_provider_request` / `turn_end` / `message_end`, project & Git status aggregation, context/cost telemetry, and mounted the `"hud"` sidebar rail part with cleanup in `ctx.ui.setFooter`.
- [x] T5 — Full Verification: Run all unit and integration tests in `gentle-pi` to verify zero regressions.
  - Verified with `node --experimental-strip-types --test tests/shell-hud.test.ts` (6/6 passing).
  - Verified with `node --experimental-strip-types --test tests/shell-sidebar-layout.test.ts` (39/39 passing).
  - Verified with `node --experimental-strip-types --test tests/shell-sidebar.test.ts` (7/7 passing).
  - Verified with `node --experimental-strip-types --test tests/shell-sidebar-fullscreen.test.ts` (2/2 passing).
  - Verified typecheck with `node scripts/check-types.mjs` (0 regressions, 14 improved).
- [x] T6 — Dense HUD Compaction & Sidebar Deduplication: Refactor `renderHudCard` to an ultra-compact 5-line format (top border + 3 dense rows + bottom border) and deduplicate `Project` and `Changes` in `renderShellSidebarBar` when HUD is active to eliminate vertical scroll when ODD tasks are rendered.
  - Evidence: `npx tsx --test tests/shell-hud.test.ts tests/shell-sidebar-layout.test.ts` passed 54/54 tests. Reduced HUD card from ~16 lines to 5 lines and omitted redundant `Project`/`Changes` from `Status` (~14 lines saved), saving ~25 vertical lines in the sidebar rail.

## 4. Acceptance Criteria & Verification

- `tests/shell-hud.test.ts` passes with 100% coverage of HUD card rendering.
- `hudDigest` changes whenever branch, diff, latency, cost, tokens, or MCP server counts change, and remains stable when identical.
- In terminal width $\ge 140$ columns and `fullscreen` mode, the `ENVIRONMENT HUD` card is rendered at the top of the rail with all 3 modules visible.
- Running `pnpm test` in `gentle-pi` exits with code 0.

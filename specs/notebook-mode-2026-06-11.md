# Notebook Mode for Investigate — Spec

> Created: 2026-06-11
> Status: Phase 1 implemented (2026-06-11) — per-step cell compose, `__cells` streaming, NotebookView, view toggle. Phases 2–3 pending.
> Builds on: `agentic-grounding-audit-trail` (merged 2026-06-11) — investigation audit trail, narrative grounding, step citations

## 1. Overview

Render each Investigate step as a live notebook cell — question, code, data, and charts together — turning the investigation from a "wait, then read a dashboard" experience into a notebook that writes itself while you watch. This is Hermetic's direct answer to Hex's notebook mode, with a differentiator Hex cannot copy by construction: the notebook is **agent-authored, citation-grounded, and provenance-tracked**, because every cell descends from an audited investigation step rather than hand-typed code.

**The strategic insight:** Hex's core differentiator is the reactive cell DAG that users build by hand. Hermetic's Investigate planner already builds that DAG (`depends_on` between sub-questions). Notebook mode surfaces it.

## 2. What exists today (post-merge inventory)

| Piece                                                                                                                   | Where                                                                                | State                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Per-step trace: question, rationale, code, results, chart_data, capped datasets, status, `source`, `depends_on`, timing | `src/lib/pipeline/investigation-trace.ts` (`InvestigationTrace`, `TraceStep`)        | ✅ shipped, persisted via `CachedArtifacts.investigation` → history                                          |
| Trail tab: per-step inspection + edit-and-rerun of a step's code                                                        | `src/components/app/artifacts-viewer.tsx`                                            | ✅ shipped                                                                                                   |
| Step citations `(Step N)` → superscripts, gated to Investigate specs                                                    | `src/components/registry-primitives.tsx` (`CitationsContext`, `renderWithCitations`) | ✅ shipped — not yet clickable                                                                               |
| Narrative grounding verdict (`GroundingReport`)                                                                         | `src/lib/pipeline/grounding.ts`                                                      | ✅ shipped                                                                                                   |
| Composition                                                                                                             | `src/lib/llm/investigate-composer.ts`                                                | ⚠️ single unified spec composed **after** all steps; results flattened into one `step_N_`-prefixed namespace |
| Per-step SQL (warehouse)                                                                                                | `src/app/api/query/investigate/route.ts`                                             | ❌ deferred (steps are Python-only)                                                                          |
| DAG-aware re-run                                                                                                        | —                                                                                    | ❌ step rerun is single-step; dependents are not invalidated                                                 |

## 3. Locked decisions

1. **Per-step compose.** Each step gets its own mini-spec composed immediately after it executes, so cells render progressively while the investigation is still running. A final **synthesis cell** carries the cross-step narrative (executive summary + conclusion + grounding verdict).
2. **View toggle, not replacement.** Notebook is a sibling view to the existing dashboard, over the same artifacts. The unified dashboard compose is unchanged.
3. **DAG-aware re-run.** Editing and re-running cell N marks all transitive dependents (via `TraceStep.depends_on`) stale, with a one-click "re-run dependents".
4. **Citations link to cells.** A `(Step N)` superscript in any narrative becomes a click-through that scrolls to and highlights cell N (in notebook view; in dashboard view it switches to notebook view anchored at the cell).
5. **Fast-follows, NOT v1:** per-step SQL for warehouse investigations; cell editing beyond the existing edit-and-rerun path (no markdown cells, no adding/reordering cells); drill-down inside cells.

## 4. UX specification

### View toggle

- Segmented control `Dashboard | Notebook` in the response-panel header, visible only when the active result is an Investigate (spec state has `__plan`).
- Default: Dashboard. Last choice remembered (localStorage) per browser.

### Cell anatomy (top to bottom)

1. **Header** — `Step N` badge, question (heading), status chip (`success | degraded | failed | removed`), source chip (`planner | re-planner | composer`), execution time. Rationale as a muted subline.
2. **Code** — collapsible CodeMirror (collapsed by default, Python), with the existing Copy / Download / Edit & Re-run affordances reused from the Trail tab.
3. **Output** — the step's mini-spec rendered with the existing `Renderer` + registry (charts, stat cards, one-line insight). Degraded steps render output plus the validator's warning annotation; failed steps render the error annotation only.
4. **Data** — collapsed "Data (N rows)" disclosure rendering the step's capped dataset preview (same table components as the artifacts Data tab).

### Progressive rendering

- When the plan lands (`__plan`), all cells appear immediately in **pending** state (header only).
- As each step finishes and its mini-spec streams in, the cell fills in live. Re-planner additions append cells; removals collapse the cell to a "dropped by re-planner: {rationale}" stub.
- The synthesis cell appears last, after the unified compose.

### Synthesis cell

- Executive summary + conclusion (with citation superscripts), the grounding verdict line, and the decision log (re-planner/composer decisions) as a collapsible "How the agent got here" disclosure.

### Stale-cell flow (re-run)

- "Edit & Re-run" on cell N (existing path) → on success, cell N re-renders; every transitive dependent gets a **stale** banner: "Depends on Step N, which changed — Re-run".
- A toolbar action "Re-run 3 stale cells" runs them in dependency order. The dashboard view also gets a stale banner (it is not recomposed in v1).

## 5. Architecture

### 5.1 Per-step compose

- New `composeStepCell()` in `src/lib/llm/` — small LLM call taking one step's question/rationale/results/chart_data shapes, emitting a mini-spec (cap ~6 components: heading optional, 1–2 charts, insight TextBlock). Same JSONL patch protocol; placeholders resolve against the step's **own** unprefixed namespace.
- Dispatched immediately when a step succeeds, concurrent with the next wave's execution — compose latency hides behind sandbox time.
- Persisted as `TraceStep.cellSpec?: Spec`, so notebooks reload from history for free.

### 5.2 Streaming protocol

- New NDJSON patches: `/state/__cells/{index}` → `{ status, cellSpec }` emitted per step, alongside the existing `__plan` status patches. The client builds the notebook from `__plan` (skeleton) + `__cells` (filled cells).
- Synthesis: composer emits `/state/__synthesis` → `{ summary, conclusion }` (small prompt change to the unified composer: tag those blocks), plus existing `__grounding`.

### 5.3 Notebook view component

- `NotebookView` in `src/components/app/` — maps `InvestigationTrace.steps` (or live `__cells` state while streaming) to `<NotebookCell>`s. Each cell's output renders with its own `StateProvider` (`cellSpec.state`) + `RendererErrorBoundary` + `CitationsContext`.
- Citation click-through: extend the `<sup>` in `renderWithCitations` to dispatch a `scrollToCell(stepNo)` callback via context; cells register anchors by `stepNo`.

### 5.4 DAG-aware re-run

- New endpoint `POST /api/query/investigate/rerun-step` — `{ csv_id, step_index, code }`:
  1. Executes via `runPipelineWithCode` (same as `/api/query/rerun`).
  2. Updates the cached trace's `TraceStep` in place (code, results, chart_data, datasets re-capped, timing).
  3. Re-runs `composeStepCell()` for that step; returns `{ step, cellSpec, dependents }` where `dependents` is the transitive closure over `depends_on`.
- Client marks `dependents` stale; "re-run dependents" walks them in topological order through the same endpoint (their code unchanged — re-execution picks up nothing new in v1 since steps don't share runtime state, but re-running revalidates results and clears the stale flag; see Open Questions).

### 5.5 Cost & performance

- +1 small compose call per successful step (~5–8 per investigation). Bounded output (≤6 components) keeps tokens low; calls overlap execution.
- Notebook view renders N small specs instead of one large one — no new perf concerns; per-cell `StateProvider` keeps state namespaces independent.

## 6. Implementation plan

**Phase 1 — Cells exist (read-only notebook).**
`composeStepCell` + `TraceStep.cellSpec` + `__cells` streaming + `NotebookView` + view toggle + progressive pending→filled rendering. _Deliverable: watch a notebook write itself during an Investigate; reload it from history._

**Phase 2 — The notebook reads like a document.**
Synthesis cell (`__synthesis` tagging), decision-log disclosure, citation click-through (both views), data disclosures. _Deliverable: citations navigate; synthesis carries the narrative._

**Phase 3 — The notebook is alive.**
`rerun-step` endpoint, in-place cell update + recompose, stale propagation via `depends_on`, "re-run stale cells" in topological order, dashboard stale banner. _Deliverable: edit cell 2's code, watch cells 3 and 5 flag stale, one click re-runs them._

**Fast-follows (separate specs):** per-step SQL for warehouse investigations (unlocks SQL cells and lifts the v1 limitation that steps don't share state); markdown/annotation cells; cell add/reorder; notebook export.

## 7. Testing

- Unit: `composeStepCell` prompt/parse (mirror `investigate-composer.test.ts`); transitive-dependent closure helper; `__cells` patch emission ordering (pending → filled → synthesis).
- Component: `NotebookView` renders pending/filled/degraded/failed/removed cells from a fixture trace; citation click scrolls to the right anchor; stale banner appears on dependents after a mocked rerun-step response.
- Integration: investigate route streams `__cells` patches; history reload renders the notebook from persisted `cellSpec`s; rerun-step updates the cached trace and preserves `investigation` (regression guard from the 2026-06-11 review).

## 8. Risks & open questions

1. **Re-running dependents is currently a no-op data-wise** — steps don't consume each other's outputs at runtime (each runs standalone Python over the source data). The DAG is semantic (planning order), not dataflow. v1 re-run of dependents revalidates rather than recomputes-with-new-inputs. True dataflow (step N reads step M's output frame) is the deep fix and pairs naturally with the per-step SQL fast-follow. The spec keeps the UX (stale → re-run) so the mental model is right from day one.
2. **Cell/dashboard divergence after re-run** — v1 marks the dashboard stale rather than recomposing it. Acceptable if clearly flagged; revisit if users live in both views.
3. **Composer drift between cell insight and synthesis claims** — synthesis is composed from final step results; if a cell is re-run afterward, synthesis is also stale. Covered by the same stale flag.
4. **Mini-spec quality variance** — a per-step compose sees less context than the unified composer. Mitigate: pass the original question + approach line into `composeStepCell` for framing, and keep per-cell insights strictly about that step (the unified composer already follows this rule).

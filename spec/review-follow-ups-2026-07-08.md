# Review Remediation — Remaining Follow-Ups

_Created: 2026-07-08_

**Source:** [`audits/full-codebase-review-2026-07-07.md`](../audits/full-codebase-review-2026-07-07.md) — the full-codebase review whose findings were remediated across ~75 commits on `remote-cloud-parquet-source` (PR #93), finishing 2026-07-08. Every finding was addressed except the items below, each deliberately scoped out of its parent commit with the rationale recorded there. This file is the TODO list for the leftovers.

Ordered roughly by value-per-effort.

---

## TODO 1 — TEST-7: Playwright smoke tests

**Status:** Deferred by explicit instruction ("do #1 and #2 except TEST-7").

The one review finding not addressed at all. A minimal browser-level smoke pass (upload sample CSV → ask a question → dashboard renders; open artifacts panel; expand a chart) would also unblock TODOs 3 and 4, which are parked specifically because no UI test coverage exists to catch visual/behavioral regressions.

- Review entry: TEST-7 in the audit's §4 register.
- Note: this is the _keystone_ item — several other TODOs cite its absence as their blocker.

## TODO 2 — FE-9 remainder: severity-token remaps in `.dark-surface-override`

**Status:** Noted in commit `e814fa0` (FE-9).

`.dark-surface-override` (the always-dark artifacts sheet / settings drawer surface) remaps text/surface/syntax tokens but **not** the severity tokens (`--color-error-text`, `--color-success-text`, …). Consequences today:

- 5 hexes in `src/components/app/settings/connected-sources-section.tsx` (`#f87171` ×4, `#10b981` pill) could not be tokenized — light-theme severity values would be unreadable on the dark drawer.
- Severity-token text inside the artifacts sheet is dim when the app is in light mode (pre-existing trait, now consistent across all statuses).

**Fix:** add severity remaps to `.dark-surface-override` in `src/app/globals.css`, then convert the 5 remaining drawer hexes to tokens. Small, self-contained.

## TODO 3 — FE-8 remainder: per-segment keyboard drill/select path

**Status:** Scoped out in commit `d0e94a5` (FE-8).

Chart drill/cross-filter is nivo `onClick` on SVG with no keyboard analogue. Controls/dialog/labeling shipped; what's missing is a way for a keyboard user to pick a _segment_ (bar, slice) to drill into or filter by. A real fix is a segment menu (e.g. focusable listbox of categories fed from the chart's data) or roving tabindex over data points — feature work, not scaffold. The expanded view's DataTable is the interim keyboard route to the data.

**Suggested shape:** a `ChartShell`-level affordance — when `isDrillable`/`isSelectable`, render a visually-hidden "Drill into…" menu button listing the x-axis categories, invoking the same `drillClickValueRef` + `emit("click")` path the mouse uses.

## TODO 4 — ARCH-5 remainder: split page.tsx's render tree

**Status:** Scoped out in commit `417b30a` (ARCH-5 part 3).

`src/app/page.tsx` is down to ~1090 lines (from 1684 at review time); the logic clusters are now hooks (`use-history-restore`, `use-viz-actions`, `use-source-select`, `use-suggestions`, `use-save-export`, `use-page-state`). What remains is ~350 lines of state/hook wiring plus a ~650-line render tree. Reaching the review's <400-line target means extracting section components — `TopBarCluster`, `SourceScreen` (state 1), `AskScreen` (state 2), `AnalysisView` (states 3/4) — each needing 30+ props or a page-context provider.

**Blocked on:** TODO 1 (UI smoke coverage) — a prop-plumbing mistake in this split would ship invisibly today.

## TODO 5 — FE-12 remainder: incremental ChartShell adoption

**Status:** By design in commit `48ce27e` (FE-12).

`ChartShell` + shared `truncateLabel`/`legendItemWidth` exist (`src/components/charts/chart-shell.tsx`, `src/lib/chart-theme.ts`); bar/line/area/map3d are converted. ~55 other charts still carry the copy-pasted title-block/wrapper scaffold. Convert each as it's next touched (the shell header documents this policy); a one-shot sweep is deliberately avoided until TODO 1 lands. Converting also gives each chart the `role="img"`/aria-label from FE-8 for free.

## TODO 6 — ARCH-12 remainder: descriptor-driven connect-form fields

**Status:** Documented seam in commit `697eb2b` (ARCH-12).

`src/lib/warehouse/engine-descriptor.ts` consolidates everything per-engine except the driver factory (node-only imports) and the **connection form UI**: `warehouse-connect-panel.tsx` and `inline-connection-form.tsx` still hand-build per-engine field sets. Extending `EngineDescriptor` with a `fields: [{key, label, inputType, placeholder, optional}]` array and driving both forms from it would take the new-engine checklist down to: types union + zod schema + connector module + factory case + one descriptor entry.

**Risk note:** this rewrites two working forms with no UI tests — same blocker as TODOs 4/5 (TODO 1).

---

## Explicitly rejected (do not resurrect without new evidence)

- **API-6 "generic client error messages":** the review suggested hiding error detail behind generic messages. Rejected in commit `4a6c15d` — Hermetic is local-first; the operator owns the server, and the real (300-char-capped) message is what makes failures actionable. Detail is now also always server-logged.
- **One-shot 59-chart ChartShell sweep:** see TODO 5 — incremental adoption chosen deliberately.

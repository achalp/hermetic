# Tier 1 Implementation Summary

_Last updated: 2026-04-25_

All seven Tier 1 competitive-gap items implemented per
[`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md),
with all originally-deferred items now shipped except a handful explicitly
out of scope (documented inline).

---

## Status

| #   | Item                                            | Status                                              | Tests | Test plan                                                                |
| --- | ----------------------------------------------- | --------------------------------------------------- | ----- | ------------------------------------------------------------------------ |
| 3   | Follow-up question suggestions                  | ✅ shipped                                          | 11    | [follow-up-suggestions](./tier-1-follow-up-suggestions-test-plan.md)     |
| 6   | dbt metadata enrichment                         | ✅ shipped                                          | 14    | [dbt-metadata-enrichment](./tier-1-dbt-metadata-enrichment-test-plan.md) |
| 1   | Snowflake + Databricks connectors               | ✅ shipped                                          | 13    | [snowflake-databricks](./tier-1-snowflake-databricks-test-plan.md)       |
| 7   | More input widgets                              | ✅ shipped                                          | 13    | [input-widgets](./tier-1-input-widgets-test-plan.md)                     |
| 4   | **Pivot table (multi-value, multi-aggregator)** | ✅ shipped — **expanded 2026-04-25**                | 22    | [pivot-table](./tier-1-pivot-table-test-plan.md)                         |
| 2   | **Edit-and-rerun (rebuilds dashboard)**         | ✅ shipped — **dashboard rebuild added 2026-04-25** | 4     | [edit-and-rerun](./tier-1-edit-and-rerun-test-plan.md)                   |
| 5   | **Scheduled local re-runs (with Settings UI)**  | ✅ shipped — **Settings UI added 2026-04-25**       | 18    | [scheduled-runs](./tier-1-scheduled-runs-test-plan.md)                   |

**Plus:** 13 page-state reducer tests covering the new `RERUN_WITH_EDITED_CODE` action.

**Total automated tests:** 308/308 passing across 30 test files.

```bash
npx vitest run    # full suite
npm run type-check
npm run build     # production build
```

All pass clean.

---

## What changed in the 2026-04-25 update

The user reviewed the original v1 deferrals and asked for them addressed:

### #2 Edit-and-rerun now rebuilds the dashboard, with SQL editing too

- `/api/query` accepts `context.code` and `context.sql`. When `code` is present, the route skips Python code-gen and runs `runPipelineWithCode`. When `sql` is present (warehouse only), the route skips NL-to-SQL generation and executes the edited SQL — the result CSV's schema is re-extracted and Python code-gen runs against the new shape.
- A new `RERUN_WITH_EDITS` page-state action carries optional `code` and `sql`. ResponsePanel forwards both as `context.code` / `context.sql` automatically.
- The artifacts viewer's `onRequestRerun` callback evolved to `(edits: { code?, sql? }) => void`. Python tab Re-run sends `{code}`; SQL tab Re-run sends `{sql}`.
- SQL tab is now editable in CodeMirror (was read-only) with its own Re-run + Discard buttons.
- The legacy artifacts-only `/api/query/rerun` endpoint is preserved for Python-only refresh; SQL editing always takes the full rebuild path because the result schema may change.
- Spec: [`sql-edit-rerun-2026-04-25.md`](../sql-edit-rerun-2026-04-25.md)

### #4 Pivot table is now multi-value, multi-aggregator

- New `measures: [{value, aggregator, label?, format?, precision?}, ...]` prop. When set, overrides single-value `value`+`aggregator`.
- Two-level header: colDim values on top, measure labels under each.
- Per-measure totals (each measure has its own row/col total + grand total — sum totals are additive, mean column-totals correctly recompute from underlying values to avoid mean-of-means).
- Backwards-compatible: existing single-value pivots keep working unchanged.
- 8 new unit tests covering multi-measure semantics, including a 1200-cell perf benchmark (50 × 8 × 3 measures completes in <200ms).

### #5 Scheduled runs now has a Settings UI

- New "Auto-runs" section in the Settings drawer.
- For every saved visualization, a row with cadence dropdown, auto-export checkboxes (XLSX/CSV), Run-now button, and live status badge.
- All API calls go through the existing `setSchedule`, `deleteSchedule`, `runScheduleNow` client helpers.

### Browser smoke testing

See [`tier-1-smoke-test-report.md`](./tier-1-smoke-test-report.md) for full details. Summary:

- ✅ `npm run build` clean
- ✅ All 308 unit tests pass
- ✅ Dev server boots, serves home + history, every endpoint contract verified via curl
- ✅ Live LLM call confirms follow-up suggestions go _deeper_ (not just rephrase)
- ⚠ Sandbox-dependent flows (full edit-rerun execute, scheduled run-now) couldn't run end-to-end in this environment because Docker / E2B / Microsandbox are all unavailable — test plan documents the manual UI checklist for human validation

### Scheduler-loop caveat documented

See [`scheduler-loop-explained.md`](./scheduler-loop-explained.md). Covers:

- Why a single `setInterval` inside the Next.js server is the right design for a single-tenant local app
- What HMR does to the loop in dev mode (and why it self-heals on next API touch)
- How catch-up runs after process restart work
- File-watcher behavior + edge cases
- Why this design instead of OS cron
- A clear "things this scheduler explicitly does NOT do" table

---

## Deliverables

- Spec / plan: `spec/tier-1-implementation-plan-2026-04-25.md`
- Per-item test plans: `spec/testing/tier-1-*-test-plan.md` (7 files)
- Cross-cutting summary: this file
- Smoke-test report: `spec/testing/tier-1-smoke-test-report.md`
- Scheduler explainer: `spec/testing/scheduler-loop-explained.md`
- Sample fixtures: `data/test-fixtures/tier-1/` (5 directories)
- Helper script: `scripts/bump-mtime.sh`

---

## What is genuinely deferred to a future release

These remain out of scope, with clear reasoning:

| Feature                                                                                  | Why                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Snowflake / Databricks OAuth + keypair auth                                              | v1 uses password / PAT. Cleanly additive; doesn't block adoption.                 |
| dbt Cloud API support                                                                    | File-based manifest covers the common workflow. Cloud requires API auth.          |
| Pivot subtotals at intermediate levels, drill-into-cell, conditional formatting per cell | Each is its own scoped feature with no current user request.                      |
| PDF / DOCX / PPTX auto-export from scheduled runs                                        | Client-side exporters; need Puppeteer or server-side port. XLSX + CSV ship today. |
| Custom cron expressions for schedules                                                    | Five presets cover ~95% of intent. Cron is its own footgun.                       |

---

## Recommended next steps

1. **Run the full UI smoke-test checklist** in [`tier-1-smoke-test-report.md`](./tier-1-smoke-test-report.md) §4 in an environment with a working sandbox runtime (Docker, E2B, or Microsandbox).
2. **Validate dbt enrichment end-to-end** with a real warehouse + manifest.
3. **Validate Snowflake / Databricks live** with real credentials.

After those three confirmations, Tier 1 is fully closed.

# Tier 1 Competitive-Gap Implementation Plan

_Last updated: 2026-04-25_

**Source of priorities:** [`competitive-feature-gaps-2026-04-25.md`](./competitive-feature-gaps-2026-04-25.md) — Tier 1 items extracted from the April 2026 Hex / Julius / Power BI / ThoughtSpot comparison set.

This document specifies the seven Tier 1 features in implementable detail. Each section defines the user-facing goal, design surface, files touched, acceptance criteria, sample test data, and risks. The implementation order below was chosen by leverage-per-day, not by item number.

---

## Implementation order and protocol

| Order | Item                                     | Est. days | Why this slot                                                           |
| ----- | ---------------------------------------- | --------- | ----------------------------------------------------------------------- |
| 1     | **#3 Follow-up question suggestions**    | 1–2       | Smallest lift, immediate AI-quality win, reuses existing `/api/suggest` |
| 2     | **#6 dbt metadata enrichment**           | 2–3       | Pure additive, no architectural change, sharpens AI on warehouses       |
| 3     | **#1 Snowflake + Databricks connectors** | ~5        | Biggest connector gap; clean plug-in surface already in place           |
| 4     | **#7 More input widgets**                | 4–6       | Pattern is established; bundle as one shippable batch                   |
| 5     | **#4 Pivot table**                       | 3–5       | Strict v1 scope (rowDim × colDim × one value × one aggregator)          |
| 6     | **#2 Edit-and-rerun on generated code**  | 3–5       | Touches the pipeline; CodeMirror integration                            |
| 7     | **#5 Scheduled local re-runs**           | 5–8       | Largest lift, biggest surface area; do last when patterns are settled   |

**Per-item protocol:**

1. Implement against the spec below.
2. `npm run type-check` and `npm run lint` must pass.
3. Author tests where appropriate (Vitest for unit logic; manual UI smoke test instructions for component work).
4. **Check-in:** brief status report to user with the diff summary, type-check/test results, and outstanding caveats — pause for user direction before proceeding.
5. Write a per-item testing document at `spec/testing/tier-1-{item-slug}-test-plan.md`.
6. Drop sample test data at `data/test-fixtures/tier-1/{item-slug}/` (ignored by upload-size limits since they're <100MB).
7. Move to next item.

**Out of scope across the board:** real-time multiplayer, RBAC, hosted infrastructure, LLM provider additions, schema/spec-format changes that break saved vizs.

---

## Item #3 — Follow-up question suggestions

### Goal

After every successful analysis, surface 3 LLM-generated follow-up questions that probe deeper into the _result_, not just the schema. User clicks one to run a new analysis with the same data source.

### Why now

`/api/suggest/route.ts` already does schema-driven suggestion at file-load. The same machinery, fed the executed question + results summary + chart types used, produces post-analysis follow-ups for cents per call (Haiku). `suggestion-pills.tsx` already renders them.

### Design

- **API:** extend `/api/suggest` with `mode: "schema" | "follow-up"`. Default remains `"schema"` for back-compat.
- **Follow-up payload:** `{ mode: "follow-up", schema, question, resultsSummary, specSummary }`.
  - `resultsSummary` = first 10 keys of `artifacts.results` plus the first 5 rows of each `chart_data.*`. Capped at ~2 KB.
  - `specSummary` = ordered list of component types in the rendered spec (e.g. `["StatCard", "BarChart", "DataTable"]`).
- **Prompt:** new system prompt instructs the model to ask _novel_ questions that take the current finding as a premise. Few-shot examples: "If the chart shows X grew, ask why or what segments drove it." Reject prompts that just rephrase the original.
- **Model:** Haiku 4.5 (`claude-haiku-4-5-20251001`). Lower temperature (0.5).
- **UI:** new component slot below the dashboard, above the analysis-history rail. Reuse `SuggestionPills`. Fire-and-forget after the spec stream completes — never block render.
- **Caching:** keyed on `(question + resultsSummary hash)`; reuse existing artifacts-cache TTL semantics. Avoid regenerating on theme switches.

### Files touched

- `src/app/api/suggest/route.ts` — extend payload & prompt branching
- `src/lib/suggest-questions.ts` — add `generateFollowUpSuggestions()`; refactor common helpers
- `src/lib/llm/prompts.ts` — new follow-up system prompt
- `src/components/app/main-content.tsx` — trigger follow-up fetch on pipeline success
- `src/components/app/suggestion-pills.tsx` — minor: optional heading override ("Try next" vs "Try asking")
- `src/lib/types.ts` — `FollowUpSuggestionRequest` type

### Acceptance criteria

- [ ] After successful analysis, 3 follow-up chips appear within 2s
- [ ] Clicking a chip runs a new analysis using the same source
- [ ] Chips disappear if a follow-up is clicked or a new analysis starts
- [ ] No follow-ups produced for failed analyses
- [ ] Type-check passes; existing schema suggestions still work
- [ ] Vitest covers the prompt-payload builder and the dedup-vs-original logic

### Sample test data

`data/test-fixtures/tier-1/follow-up-suggestions/sales-2024.csv` — 12 months × 4 product categories × revenue / units / discount columns. Asking "What were total sales by quarter?" should produce follow-ups along the lines of "Which category contributed most to Q4?" / "Did discounting drive Q3 growth?" / "Compare Q4 2024 to Q4 2023."

### Risks

- Suggestion quality without curated examples — mitigate with 3-shot prompt
- Token cost on every analysis — Haiku makes this ~$0.0002/call

---

## Item #6 — dbt metadata enrichment

### Goal

When a Hermetic warehouse connection is paired with a dbt project, table descriptions, column descriptions, lineage, and tests enrich the LLM context. The model writes more accurate SQL because it knows what `dim_customer.last_seen_at` actually means.

### Design

- **Inputs:** path to a `manifest.json` (and optionally `catalog.json`) — set per warehouse connection in Settings.
- **Index:** parse the manifest once on connection load; cache a `Map<"db.schema.table", DbtTableMeta>` in memory.
- **Schema enrichment:** extend `WarehouseTableSchema` with optional `description?: string` and `column_descriptions?: Record<string, string>`. Existing call sites that don't care about descriptions keep working.
- **Prompt:** `formatTableSchemas()` in `sql-generation.ts` renders descriptions inline as SQL comments above each table and after each column when present.
- **UI:** Settings → Connected Sources → expandable "dbt project" panel per warehouse connection, with a "Path to manifest.json" field and a `(linked / not linked / load failed)` badge in the data-explorer.
- **Validation:** parse defensively. Pin to dbt manifest schema v10/v11 (current). Tolerate missing fields.
- **Out of scope:** dbt Cloud API auth (file-only for v1), incremental refresh detection, dbt tests rendering as guardrails.

### Files touched

- `src/lib/warehouse/dbt-metadata.ts` — new: parse + index
- `src/lib/types.ts` — extend `WarehouseTableSchema`
- `src/lib/warehouse/sql-generation.ts` — render descriptions in `formatTableSchemas`
- `src/lib/warehouse/storage.ts` — persist dbt manifest path per saved connection
- `src/components/app/settings/connected-sources-section.tsx` — UI for setting the path
- `src/components/app/data-explorer/table-list.tsx` — small badge when dbt-linked
- `src/lib/api.ts` — endpoint surface for testing/loading the manifest
- `src/app/api/warehouse/dbt-metadata/route.ts` — new endpoint

### Acceptance criteria

- [ ] Pasting a path to `manifest.json` shows "linked: 47 models" within 1s
- [ ] LLM-generated SQL prompt includes the table/column descriptions for any covered table
- [ ] Connections without dbt continue to work identically
- [ ] Schema/SQL doesn't change at all when dbt is not linked
- [ ] 10 MB manifest parses in <500ms; subsequent reads use cache
- [ ] Unit test for the parser against a fixture manifest

### Sample test data

`data/test-fixtures/tier-1/dbt-enrichment/jaffle_shop_manifest.json` — trimmed jaffle_shop manifest with 4 models (customers, orders, payments, stg_orders). Each has a description; columns have descriptions where dbt typically declares them.

### Risks

- Manifest-version drift: pin parser, log unknown structures
- Path security: read-only, validated to be a real `manifest.json` (must contain `metadata.dbt_schema_version`)
- Memory: cache parsed object per connection; clear on disconnect

---

## Item #1 — Snowflake + Databricks connectors

### Goal

Add Snowflake and Databricks SQL warehouses to the existing 5 (Postgres, BigQuery, ClickHouse, Trino, Hive) — the single biggest gap relative to every competitor.

### Design

- **SDK choice:**
  - Snowflake → `snowflake-sdk` (official Node)
  - Databricks → `@databricks/sql` (official Node)
- **Auth:**
  - Snowflake: password (v1), OAuth + keypair (v2)
  - Databricks: PAT (v1), OAuth (v2)
- **Schema introspection:**
  - Snowflake: `INFORMATION_SCHEMA.COLUMNS` + `INFORMATION_SCHEMA.TABLE_CONSTRAINTS`. Identifiers: double-quoted, case-sensitive when quoted.
  - Databricks: `system.information_schema.columns` (Unity Catalog) or `INFORMATION_SCHEMA.COLUMNS` per workspace. Use Unity Catalog three-part names (`catalog.schema.table`).
- **executeSQL:** convert result rows to CSV string matching the existing `WarehouseConnector` contract. Databricks Arrow result → flat row array first.
- **Connection config (new types):**
  ```ts
  interface SnowflakeConnectionConfig {
    type: "snowflake";
    account: string; // e.g. "abc12345.us-east-1"
    user: string;
    password: string;
    warehouse?: string;
    database: string;
    schema?: string;
    role?: string;
  }
  interface DatabricksConnectionConfig {
    type: "databricks";
    serverHostname: string; // e.g. "abc-123.cloud.databricks.com"
    httpPath: string; // e.g. "/sql/1.0/warehouses/abc123"
    token: string; // Personal access token
    catalog: string; // Unity Catalog
    schema?: string;
  }
  ```
- **UI:** add two tabs to `warehouse-connect-panel.tsx` — `snowflake` and `databricks`. Form labels match the connection-config fields.
- **Dialect notes:** add to `DIALECT_NOTES` in `sql-generation.ts`.
  - Snowflake: standard ANSI + Snowflake quirks (`QUALIFY`, `TIME_SLICE`, `IFF`)
  - Databricks: ANSI + Spark SQL (`DATE_FORMAT`, `EXPLODE`, no `LIMIT BY`, must qualify with three-part names)
- **Sample datasets in README:** Snowflake sample share (`SNOWFLAKE_SAMPLE_DATA.TPCH_SF1`); Databricks Unity Catalog sample (`samples.nyctaxi.trips`).

### Files touched

- `src/lib/warehouse/snowflake.ts` — new (~150–200 lines)
- `src/lib/warehouse/databricks.ts` — new (~150–200 lines)
- `src/lib/types.ts` — extend `WarehouseType` union, add config types, extend `WarehouseConnectionConfig` discriminated union
- `src/lib/warehouse/connector.ts` — extend `createConnector` switch
- `src/lib/warehouse/sql-generation.ts` — extend `DIALECT_NOTES` and quoting branches in `formatTableSchemas`
- `src/components/app/warehouse-connect-panel.tsx` — new tab labels, `SnowflakeForm`, `DatabricksForm`
- `src/lib/warehouse/persist-env.ts` — new env-var conventions
- `.env.example` — Snowflake + Databricks env conventions
- `README.md` — connection docs + free sample datasets
- `package.json` — add `snowflake-sdk` and `@databricks/sql`

### Acceptance criteria

- [ ] Connect to Snowflake `SNOWFLAKE_SAMPLE_DATA.TPCH_SF1`, list 8 tables with row counts
- [ ] Connect to Databricks `samples.nyctaxi.trips` via PAT, run `SELECT count(*) FROM samples.nyctaxi.trips`
- [ ] LLM-generated SQL respects each dialect's quoting + qualifying rules
- [ ] Both connectors implement all 5 `WarehouseConnector` methods
- [ ] Saved connections work for both
- [ ] Existing 5 warehouses continue to work unchanged

### Sample test data

This item requires live credentials. The testing doc includes:

- A docker-compose with `localstack-pro` for Databricks-compatible mock — _if_ feasible. Otherwise, manual test against real free Snowflake trial + Databricks Community Edition.
- Mocked driver fixtures for the unit-test layer (driver-level integration tests live in a `*.integration.test.ts` namespace, skipped by default).

### Risks

- `snowflake-sdk` has a heavy native crypto dep — verify Next.js bundling works
- Databricks Arrow batches → CSV conversion needs care for nested types (defer struct/array support, render as JSON strings in v1)
- Auth fields are sensitive — ensure they're persisted only client-side (matches current pattern)

---

## Item #7 — More input widgets

### Goal

Five new input components: `DatePicker`, `MultiSelect`, `Slider`, `ColorPicker`, `RangeSlider`. Pattern follows existing `TextInput` / `SelectControl` / `NumberInput`.

### Design

- **Native HTML where possible** to stay light-bundle:
  - DatePicker → `<input type="date">` (also `type="datetime-local"` variant)
  - Slider → `<input type="range">`
  - ColorPicker → `<input type="color">`
- **Custom for complex behavior:**
  - MultiSelect → chip-style dropdown with type-ahead search (~200 LOC)
  - RangeSlider → two-thumb on top of `<input type="range">` × 2 with shared track styling (~150 LOC)
- **Bindings:**
  - DatePicker → `string` (ISO date)
  - MultiSelect → `string[]` (new shape — DataController gets a `filterIn` op)
  - Slider → `number`
  - ColorPicker → `string` (hex)
  - RangeSlider → `[number, number]`
- **Extending DataController:** add `filterIn(column, values[])` and `filterRange(column, [min, max])` ops to support the new shapes. Keep existing ops untouched.
- **Prompt updates:** add component descriptors + when-to-use rules to `prompts.ts` catalog.

### Files touched

- `src/components/inputs/date-picker.tsx` — new
- `src/components/inputs/multi-select.tsx` — new
- `src/components/inputs/slider.tsx` — new
- `src/components/inputs/color-picker.tsx` — new
- `src/components/inputs/range-slider.tsx` — new
- `src/components/registry.tsx` — register five new components
- `src/components/registry-primitives.tsx` — extend prop type exports
- `src/components/controllers/data-controller.tsx` — add `filterIn`, `filterRange` ops
- `src/lib/llm/prompts.ts` — extend component catalog
- Tests: `src/components/__tests__/inputs.test.tsx` — basic render + binding for each

### Acceptance criteria

- [ ] Each component renders, binds via `useBoundProp`, and triggers downstream re-render
- [ ] DataController applies `filterIn` / `filterRange` correctly
- [ ] LLM prompt catalog mentions each by name with one-line guidance
- [ ] Theme tokens applied (existing 4 themes × light/dark)
- [ ] Bundle size delta < 30 KB gzipped

### Sample test data

`data/test-fixtures/tier-1/input-widgets/orders-with-tags.csv` — 200 rows, columns: `order_date`, `region` (5 values), `tags` (multi-valued comma list), `priority` (1–5), `category_color` (hex). Drives every widget.

### Risks

- LLM picking the wrong widget — use few-shot prompt examples
- MultiSelect state shape (`string[]`) needs careful initial-value handling

---

## Item #4 — Pivot table

### Goal

A `PivotTable` component for the LLM to choose when the user's question is a 2-D crosstab. Strict v1: one row dimension, one column dimension, one value column, one aggregator.

### Design

- **Component contract:**
  ```ts
  interface PivotTableProps {
    rowDim: string;
    colDim: string;
    value: string;
    aggregator: "sum" | "count" | "mean" | "min" | "max";
    rows: Record<string, unknown>[]; // long-format input
    showRowTotals?: boolean | null;
    showColTotals?: boolean | null;
    caption?: string | null;
    valueFormat?: "currency" | "percent" | "number" | null;
  }
  ```
- **Rendering:** plain `<table>` with sticky header & first column. Sortable columns. Theme-aware. Color-graded cells (low → high) optional via `gradient: boolean`.
- **No PivotTable-from-pivoted-data:** input is long-form; the component pivots client-side. Keeps the prompt simple.
- **Export:** CSV / XLSX export buttons matching existing DataTable.
- **Out of scope (v2):** subtotals at multiple levels, multi-value cells, drill-into-cell, conditional formatting per row.

### Files touched

- `src/components/pivot-table.tsx` — new (~250 LOC)
- `src/components/registry.tsx` — register `PivotTable`
- `src/lib/llm/prompts.ts` — add to component catalog with rule "use PivotTable for category × time × value crosstabs"
- `src/lib/export-utils.ts` — `downloadPivotAsXlsx` helper
- Tests: `src/components/__tests__/pivot-table.test.tsx`

### Acceptance criteria

- [ ] Long-form input pivots correctly with each aggregator
- [ ] Row + column totals render when requested
- [ ] CSV + XLSX export preserves the pivoted shape
- [ ] LLM produces correct PivotTable specs for "Show me revenue by region by quarter"
- [ ] At least 50 rows × 8 cols renders in <100ms

### Sample test data

`data/test-fixtures/tier-1/pivot-table/sales-by-region-quarter.csv` — `region` × `quarter` × `revenue` long-form for 5 regions × 4 quarters × 3 years = 60 rows.

### Risks

- Subtotals creep — hold the line at v1 scope
- Wide pivots overflow horizontally — sticky-cell scroll handles it

---

## Item #2 — Edit-and-rerun on generated code

### Goal

The Artifacts panel becomes editable for both SQL and Python tabs. A "Re-run" button executes the edited code, replaces the current dashboard.

### Design

- **Editor:** `@uiw/react-codemirror` (~150 KB minimal, much lighter than Monaco). Python + SQL highlighters from `@codemirror/lang-python` and `@codemirror/lang-sql`. Theme adapts to light/dark.
- **Rerun pipeline (Python):**
  - New `runPipelineWithCode()` in `orchestrator.ts` that skips step 1 (code-gen) and goes straight to step 2 (execute).
  - On success, run the existing UI-compose step.
  - On error, surface inline in the editor with the error message; do not crash the dashboard.
- **Rerun pipeline (SQL — warehouse only):**
  - New `runWarehouseQueryWithSql()` that re-issues the edited SQL → CSV → existing analysis pipeline (skipping SQL-gen).
- **API:** `POST /api/query/rerun` with `{ mode: "python" | "sql", code, csv_id?, warehouse_id?, schema, question }`. Streams the spec the same way the main `/api/query` does.
- **Cache invalidation:** edited code busts the artifacts cache for the question; a fresh execution writes a new artifacts entry.
- **UI:**
  - Replace `<pre>` blocks with CodeMirror in `artifacts-viewer.tsx`
  - "Re-run" button in the tab toolbar
  - "Discard changes" button when content differs from server-stored
  - Diff indicator dot when edited

### Files touched

- `src/components/app/artifacts-viewer.tsx` — replace `<pre>` blocks with CodeMirror, add Re-run + Discard buttons
- `src/lib/pipeline/orchestrator.ts` — add `runPipelineWithCode()` + SQL-rerun variant
- `src/app/api/query/rerun/route.ts` — new endpoint
- `src/lib/api.ts` — client-side `rerunQuery()` helper
- `src/components/app/main-content.tsx` — wire up rerun flow into existing spec-streaming pipeline
- `package.json` — `@uiw/react-codemirror`, `@codemirror/lang-python`, `@codemirror/lang-sql`, `@codemirror/theme-one-dark`

### Acceptance criteria

- [ ] Editing code does not auto-execute
- [ ] Re-run produces a new dashboard from edited code in the same flow as a fresh question
- [ ] Errors render inline with line number, do not unmount the dashboard
- [ ] Discard restores server code
- [ ] Existing copy/download buttons continue to work
- [ ] SQL re-run path triggers a warehouse query → CSV → analysis pipeline
- [ ] Bundle delta < 250 KB gzipped (CodeMirror + lang packages)

### Sample test data

Reuse any prior test CSV (e.g. follow-up suggestions fixture). Manual test: open an analysis, edit `df.groupby('region').sum()` → `df.groupby('category').sum()`, hit Re-run, expect a new dashboard.

### Risks

- Bundle size — CodeMirror minimal stays under target if we don't pull in the `basic-setup` bundle
- Edited code that imports unavailable packages — falls through to existing sandbox error path
- SSR concern — CodeMirror is client-only; gate via `dynamic()`

---

## Item #5 — Scheduled local re-runs

### Goal

A saved viz can be scheduled to re-execute on a cadence (or on file change), produce a fresh export, and notify the user. Local-first: no cloud schedulers.

### Design

- **Scope (v1):**
  - Sources supported: local files (file-watch) + uploaded CSVs (cron-only) + warehouses (cron-only)
  - Cron expressions: handful of presets (`hourly`, `daily-9am`, `daily-end-of-day`, `weekly-monday`, `on-file-change`, `on-app-launch`)
  - Auto-export after each run: choose any subset of `pdf | docx | pptx | xlsx`. Files dropped in `~/.hermetic/scheduled-runs/<viz-id>/<timestamp>.<ext>`.
- **Background loop:**
  - Long-running Node setInterval-based scheduler started on Next.js custom server boot
  - Persisted schedules in `~/.hermetic/schedules.json`
  - On dev-mode HMR reload, scheduler re-initializes from disk (idempotent)
- **File-watch:** `chokidar` against the bound-mount path; debounced 500ms.
- **Execution:** call existing schema-compat fast path in `src/lib/saved/schema-compat.ts` — re-execute saved code without LLM round-trip.
- **Notifications:** a small toast on next app open showing the last N runs (success/failure). No OS notifications in v1.
- **Settings UI:** new "Auto-runs" section listing each scheduled viz with status, last-run timestamp, next-run, last-error.

### Files touched

- `src/lib/saved/scheduler.ts` — new: scheduler core
- `src/lib/saved/schedule-storage.ts` — new: persisted schedule config
- `src/lib/saved/auto-export.ts` — new: PDF/DOCX/PPTX/XLSX rendering for headless re-runs
- `src/app/api/vizs/schedule/route.ts` — CRUD endpoints
- `src/components/app/settings/auto-runs-section.tsx` — new Settings UI
- `src/components/app/saved-vizs-panel.tsx` — "Schedule" button per saved viz
- `package.json` — `chokidar`, `node-cron` (optional, for cron-string support)
- Tests: scheduler unit tests with fake timers; auto-export rendering smoke test

### Acceptance criteria

- [ ] Schedule a saved viz at "every minute" — runs three times in three minutes
- [ ] Files appear at `~/.hermetic/scheduled-runs/<id>/<ts>.pdf`
- [ ] On-file-change schedule triggers within 1s of mtime bump
- [ ] App restart preserves schedules; missed runs are not retroactively executed
- [ ] Status indicator shows last success / failure with timestamp
- [ ] Failed runs (e.g., schema drifted) log error, schedule continues

### Sample test data and tooling

`data/test-fixtures/tier-1/scheduled-runs/sample-input.csv` plus a tiny script `scripts/bump-mtime.sh` that touches the file to test on-file-change. The testing doc walks the user through enabling a 1-minute cadence and confirming three exports.

### Risks

- Surprising background execution — explicit opt-in per saved viz, visible status
- Path drift — schedules re-validate the source path on each run; mark as "broken" if missing
- Process lifecycle — scheduler stops when app stops; spell that out in the testing doc
- Resource leaks — auto-export reuses the existing PDF/DOCX/PPTX renderers, which run client-side in the current product. Headless equivalents may need a small Puppeteer-based path

---

## Cross-cutting deliverables

- All seven items contribute to a final summary at `spec/testing/tier-1-summary.md`
- Testing docs live under `spec/testing/` with one file per item
- Sample fixtures live under `data/test-fixtures/tier-1/<item-slug>/` and are gitignored beyond a placeholder `.gitkeep`
- Each item ships with `npm run type-check` clean and `npm run lint` clean
- Manual smoke-test instructions are written in plain English in each testing doc — anyone (not just the author) can re-run them

---

## Reference

- Tier definitions and competitive context: [`competitive-feature-gaps-2026-04-25.md`](./competitive-feature-gaps-2026-04-25.md)
- Source comparisons: `comparisons/hermetic-vs-{hex,julius-vizly,powerbi,thoughtspot}-2026-04-25.md`

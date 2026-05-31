# Hermetic vs Hex.tech — Competitive Feature Comparison

_Last updated: 2026-05-31_

_Previous versions of this comparison: [2026-04-25](./hermetic-vs-hex-2026-04-25.md), [2026-03-24](./hermetic-vs-hex.md). This update reflects significant changes on the Hermetic side: Snowflake and Databricks connectors, scheduled dashboard runs, interactive pivot tables, the **Investigate** multi-step agent, edit-and-rerun on the generated Python/SQL, multi-retry with reflection, dbt metadata enrichment, and a large reliability pass across all 32 chart types. Several gaps from the April version are now closed._

## Overview

| Category        | Hermetic                                                                                       | Hex.tech                                                                |
| --------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Core Model**  | AI-first: ask a question, get a complete dashboard. **Investigate** decomposes into sub-steps. | AI Analytics Platform: notebooks + Notebook Agent + apps for whole team |
| **Deployment**  | Self-hosted / local-first                                                                      | Cloud SaaS only (single-tenant Enterprise option)                       |
| **Pricing**     | Open source (free)                                                                             | Free → $36/editor/mo (Pro) → $75/editor/mo (Team) → custom (Enterprise) |
| **Target User** | Analyst who wants answers fast, no code, data stays local                                      | Cross-functional data team: analysts, engineers, business users         |
| **AI Posture**  | LLM never sees the data — schema-only context, blind execution                                 | Notebook Agent has full schema + project context, generates code        |

---

## Data Sources

| Feature                                      | Hermetic                                                          | Hex                                                 |
| -------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| CSV upload                                   | Yes (100MB)                                                       | Yes                                                 |
| Excel (multi-sheet + relationship detection) | Yes (auto-detects cross-sheet FKs)                                | Yes (basic upload)                                  |
| GeoJSON / JSON native                        | Yes (auto geometry detection)                                     | JSON yes; GeoJSON via Python                        |
| Parquet files (single + Hive-partitioned)    | Yes (DuckDB-backed, zero-copy bind-mount)                         | Yes                                                 |
| Local file browser                           | Yes (browse host filesystem from sandbox)                         | No                                                  |
| PostgreSQL / Redshift / Neon / Supabase      | Yes (PG-wire compatible)                                          | Yes                                                 |
| BigQuery (incl. BigQuery DataFrames)         | Yes                                                               | Yes (native + BigFrames pushdown)                   |
| **Snowflake**                                | **Yes (new — inline + saved connections, dialect-aware SQL)**     | Yes (native + Snowpark pushdown)                    |
| **Databricks**                               | **Yes (new — `@databricks/sql` driver, SQL warehouse + token)**   | Yes (added Oct 2025, incl. Unity Catalog)           |
| ClickHouse                                   | Yes                                                               | Yes                                                 |
| Trino / Starburst                            | Yes                                                               | Yes                                                 |
| Hive                                         | Yes                                                               | Via Trino                                           |
| MotherDuck / DuckDB                          | DuckDB in-sandbox                                                 | Yes                                                 |
| MySQL / SQL Server / Oracle                  | No                                                                | Yes                                                 |
| Athena / AlloyDB                             | AlloyDB via PG-wire                                               | Yes                                                 |
| **dbt metadata enrichment**                  | **Yes (new — column-level descriptions pulled into LLM context)** | Yes (deep — schema enrichment, semantic-layer cell) |
| dbt / Cube / Snowflake Semantic Views        | No (descriptions only)                                            | Yes (semantic-model awareness across all four)      |
| Databricks Unity Catalog Metric Views        | No                                                                | Yes                                                 |
| API / HTTP sources                           | No                                                                | Via Python                                          |
| OAuth-per-user data connections              | No                                                                | Yes (Snowflake, Databricks, BigQuery)               |
| SSH tunneling                                | No                                                                | Yes                                                 |

**What changed:** the April doc listed Snowflake and Databricks as **No** for Hermetic; both now ship with first-class connectors, inline + saved connection forms, per-warehouse tabs and color codes in the UI, and dialect-aware SQL-generation prompts. dbt metadata enrichment is also new — if a dbt project is wired up, column descriptions flow into the same context as the warehouse schema.

**Hex still wins on warehouse breadth and semantic-layer depth** — MySQL/SQL Server/Oracle/Athena, OAuth-per-user, SSH tunneling, and full semantic-model awareness (dbt MetricFlow, Cube, Snowflake Semantic Views, Databricks Metric Views) remain Hex-only. **Hermetic still wins on file-format intelligence and zero-copy ingestion** — Parquet folders bind-mount read-only into the sandbox, so terabyte-scale local data never copies, and Excel cross-sheet FK detection is unique.

---

## AI / LLM Capabilities

| Feature                                      | Hermetic                                                                                                                                                   | Hex (Magic + Notebook Agent)                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| NL to complete dashboard                     | Yes (one prompt → multi-widget JSON-Render spec)                                                                                                           | Partial (Notebook Agent builds full notebooks/apps step-by-step) |
| NL to SQL                                    | Yes (dialect-aware, cross-table JOINs, per-warehouse prompt guidance)                                                                                      | Yes (Magic SQL, semantic-layer aware)                            |
| NL to Python                                 | Yes (generates + executes blind)                                                                                                                           | Yes (Magic Python in notebook cells)                             |
| NL to R                                      | No                                                                                                                                                         | Yes                                                              |
| NL to chart                                  | Yes (auto-selects from 32 types)                                                                                                                           | Yes (Magic Chart + Notebook Agent chart-cell generation)         |
| Inline code completion (typeahead)           | No                                                                                                                                                         | Yes (context-aware, schema-aware)                                |
| **Edit-and-rerun on generated code**         | **Yes (new — edit Python or SQL in the code editor, server skips that step and re-runs downstream)**                                                       | Yes (Magic Edit/Debug, plus direct cell editing)                 |
| Code explain / debug                         | No                                                                                                                                                         | Yes (Magic Explain, Magic Debug)                                 |
| **Multi-step agentic analysis**              | **Yes (new — Investigate: planner decomposes into 3–7 sub-questions, orchestrator runs parallel waves + serial deps, composer synthesizes one dashboard)** | Yes (Notebook Agent — autonomous multi-cell workflow)            |
| **Failure recovery (retry with reflection)** | **Yes (new — up to 3 retries; after 2 failures the model gets full failed-attempt history + a reflection prompt)**                                         | Notebook Agent retries with cell context                         |
| Multi-provider LLM                           | Yes (7: Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)                                                                                 | No (Hex chooses provider; some BYO LLM on Enterprise)            |
| Local / offline LLM                          | Yes (MLX, llama.cpp, Ollama with curated 8/16/24/48GB tiers)                                                                                               | No                                                               |
| Schema-aware code-gen                        | Yes (column types, distributions, correlations, FK relationships, dbt descriptions)                                                                        | Yes (warehouse schema, dbt docs, project execution graph)        |
| Output style control                         | Yes (6: Dashboard, Narrative, Summary, Deep Analysis, Slides, Report)                                                                                      | No (single notebook/app format)                                  |
| Drill-down re-analysis                       | Yes (click chart segment → new AI analysis with filtered context)                                                                                          | Manual re-query via Magic                                        |
| Follow-up / conversation context             | Yes (server-side conversation cache — question + code + result schema per turn)                                                                            | Yes (Threads, Magic context within project)                      |
| **Suggested follow-up questions**            | **Yes (new — inline pills after each analysis suggest the next obvious question)**                                                                         | Yes (suggested explorations)                                     |
| Suggested initial questions                  | Yes (LLM-generated from schema on data load)                                                                                                               | Yes                                                              |
| Methodology disclosure                       | Yes (plain-English summary of rows, columns, ops on every analysis)                                                                                        | Visible in cell outputs / generated code                         |
| Schema-only privacy mode                     | Yes — LLM never sees data values, only schema + statistics                                                                                                 | No (data flows through Hex's AI infra)                           |
| Verifiable outputs (audit trail)             | Yes (Artifacts panel: SQL + Python + computed tables, downloadable)                                                                                        | Yes (every AI action visible as cells + version history)         |

**The Investigate gap closes meaningfully.** Until this release Hex's Notebook Agent was the only product that could decompose a fuzzy question ("why did churn spike in Q1?") into a multi-step analysis. Hermetic's Investigate now does the same thing in a single streaming response — planner sees schema + stats only, orchestrator runs sub-questions in parallel waves where independent and serially where dependent, composer synthesizes a unified dashboard. The two approaches differ on form factor (notebook cells vs. one dashboard) but converge on capability.

**Hex still wins on iterative code-craft** — Magic Explain/Debug, R support, inline typeahead, and the multi-turn notebook editing loop. **Hermetic still wins on AI autonomy and privacy** — one question → styled dashboard with no row data leaving the host, plus 7 LLM providers including fully-local inference.

---

## Visualization

| Feature                                                    | Hermetic                                                                                                                                          | Hex                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Native chart types                                         | 32 (AI-selected from JSON-Render spec)                                                                                                            | ~14 built-in chart-cell types                |
| No-code chart creation                                     | AI-driven (fully automatic)                                                                                                                       | Drag-and-drop chart builder + Magic Chart    |
| Code-based charts                                          | Sandbox Python (matplotlib, plotly, seaborn)                                                                                                      | Full Python/R environment (any library)      |
| **Expanded full-height mode (all 32 charts)**              | **Yes (new — every chart fills available height when expanded)**                                                                                  | Yes                                          |
| **WCAG-compliant typography**                              | **Yes (new — 12px UI, 11px chart labels minimum throughout)**                                                                                     | Yes                                          |
| **Robust data shape handling**                             | **Yes (new — charts auto-unwrap nested `{data, x_key, y_keys}` objects, line/area auto-detect long-format)**                                      | N/A (user writes the code)                   |
| **Basic Charts**                                           |                                                                                                                                                   |                                              |
| Bar (grouped, stacked, horizontal)                         | Yes                                                                                                                                               | Yes                                          |
| Line (multi-series, stepped)                               | Yes                                                                                                                                               | Yes                                          |
| Area (stacked, overlaid)                                   | Yes                                                                                                                                               | Yes                                          |
| Pie / Donut                                                | Yes                                                                                                                                               | Yes                                          |
| Scatter (with regression)                                  | Yes                                                                                                                                               | Yes                                          |
| Histogram                                                  | Yes                                                                                                                                               | Yes                                          |
| **Distribution**                                           |                                                                                                                                                   |                                              |
| Box Plot, Violin, Ridgeline, Beeswarm                      | Yes (native)                                                                                                                                      | Box/Histogram native; others via Python      |
| **Hierarchical**                                           |                                                                                                                                                   |                                              |
| Treemap, Sunburst                                          | Yes (native)                                                                                                                                      | Treemap native; Sunburst via Python          |
| **Network & Flow**                                         |                                                                                                                                                   |                                              |
| Sankey, Chord, Stream                                      | Yes (native)                                                                                                                                      | Via Python                                   |
| **Comparison & Ranking**                                   |                                                                                                                                                   |                                              |
| Bump, Dumbbell, Slope, Bullet, Waterfall, Marimekko, Radar | Yes (native)                                                                                                                                      | Via Python                                   |
| **ML / Statistical**                                       |                                                                                                                                                   |                                              |
| Confusion matrix, ROC, SHAP beeswarm, Decision tree        | Yes (native)                                                                                                                                      | Via Python                                   |
| Parallel coordinates                                       | Yes                                                                                                                                               | Via Python                                   |
| **Financial**                                              |                                                                                                                                                   |                                              |
| Candlestick (OHLC)                                         | Yes (native)                                                                                                                                      | Via Python                                   |
| **Geographic**                                             |                                                                                                                                                   |                                              |
| 2D Map (markers + choropleth)                              | Yes (MapLibre GL)                                                                                                                                 | Via Folium / Plotly / Python                 |
| 3D Globe (arcs + points, arc filtering)                    | Yes (react-globe.gl)                                                                                                                              | No                                           |
| 3D Deck.gl (hexagon, column, arc, heatmap, scatter)        | Yes (5 layer types, click/hover interactivity)                                                                                                    | No                                           |
| **3D Plots**                                               |                                                                                                                                                   |                                              |
| Scatter3D / Surface3D                                      | Yes (Plotly 3D)                                                                                                                                   | Via Python                                   |
| **Calendar**                                               |                                                                                                                                                   |                                              |
| Calendar heatmap                                           | Yes (GitHub-style)                                                                                                                                | Via Python                                   |
| **Data Display**                                           |                                                                                                                                                   |                                              |
| Data table (sort, filter, paginate)                        | Yes                                                                                                                                               | Yes (with sparklines)                        |
| Stat cards / KPI                                           | Yes (StatCard + TrendIndicator + format hints)                                                                                                    | Yes (Single value / Big Number cell)         |
| **Interactive pivot tables**                               | **Yes (new — sort, drill-through, drill-down, cross-filter with other widgets, aggregator switcher, heatmap mode, multi-value/multi-aggregator)** | Yes (Pivot cell — Notebook Agent can author) |
| Conditional formatting                                     | Tables + pivot heatmap mode                                                                                                                       | Yes                                          |

**Pivot tables are the other big gap-closer.** In the April doc Hermetic had "No" for pivot tables — the DataTable was the closest equivalent. The new PivotTable is a first-class widget the LLM composes into dashboards: sort by any column, drill into a cell to see the underlying rows, cross-filter against other charts, swap aggregators (sum / mean / count / median), flip to a heatmap view, and stack multiple values or aggregators in the same view.

**Hermetic still wins on out-of-the-box chart diversity** — 32 native types AI-selected with no code, including specialized analytical charts (Sankey, SHAP, ROC, deck.gl 3D maps, candlestick) that Hex requires Python for, plus a reliability pass that fixed the long-tail of "chart renders blank" bugs from the April release. **Hex still wins on unlimited customization** — any Python or R library, fully programmable cells.

---

## Interactive App Building

| Feature                | Hermetic                                                      | Hex                                                                                                      |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Input widgets          | SelectControl, NumberInput, ToggleSwitch, TextInput, TextArea | Full suite (dropdowns, sliders, date pickers, multi-select, file upload, radio, checkbox, color, search) |
| Reactive state         | Yes (DataController pipelines, cross-chart filtering)         | Yes (cell dependency graph, reactive re-execution)                                                       |
| What-if / calculators  | Yes (compute ops: multiply, percentOf, ratio, topN, pivot)    | Yes (via Python/SQL cells)                                                                               |
| Client-side filtering  | Yes (DataController, sub-second cross-chart updates)          | Yes (filter cells + reactive re-execution)                                                               |
| Layout builder         | AI-generated (LayoutGrid, LayoutRow, LayoutColumn)            | Drag-and-drop App Builder (manual)                                                                       |
| App publishing         | No (single-user, local-first)                                 | Yes (publish as standalone web app, dashboard, or embedded report)                                       |
| Tabs / sections        | Yes (AI-composed, SectionBreak component)                     | Yes (manual)                                                                                             |
| Button triggers        | No                                                            | Yes                                                                                                      |
| Conditional visibility | No                                                            | Yes                                                                                                      |
| Reusable components    | No                                                            | Yes (Components — reusable notebook fragments)                                                           |
| Custom theming         | 4 themes × light/dark                                         | Custom CSS / fonts / colors per app                                                                      |

**Unchanged from April.** Hex's App Builder is still a flagship product. Hermetic still composes the entire interactive layout from one question with zero manual building.

---

## Collaboration, Sharing & Operations

| Feature                         | Hermetic                                                                                                                                         | Hex                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Real-time multiplayer editing   | No                                                                                                                                               | Yes (Google Docs-style)                            |
| Comments / threads              | No                                                                                                                                               | Yes (Threads on cells, also AI-aware)              |
| Version history                 | Yes (per-viz versions)                                                                                                                           | Yes (full, with restore/fork)                      |
| Git integration                 | No                                                                                                                                               | Yes (GitHub, GitLab; Enterprise)                   |
| Role-based access (RBAC)        | No                                                                                                                                               | Yes (Admin, Editor, Viewer, Publisher, App user)   |
| Workspace organization          | No                                                                                                                                               | Yes (Collections, status workflows)                |
| Published apps                  | No                                                                                                                                               | Yes (standalone web apps, dashboards)              |
| **Scheduled runs (cron)**       | **Yes (new — node-cron scheduler, schedule popover anchored to the dashboard toolbar, schedule pills on saved-viz cards, edit/delete in place)** | Yes (with email/Slack delivery)                    |
| **Persistent analysis history** | **Yes (new — auto-saves every analysis to disk; history survives restarts; dedicated history page; restore or re-run against fresh data)**       | Yes (project history + version control)            |
| Embed in other tools            | No                                                                                                                                               | Yes (signed embedding, custom theming, headerless) |
| API-triggered runs              | No                                                                                                                                               | Yes (REST API)                                     |
| Email / Slack delivery          | No (scheduled runs are local-only)                                                                                                               | Yes                                                |
| Review workflows                | No                                                                                                                                               | Yes (Draft / In Review / Published statuses)       |
| Shared data connections         | No (per-user)                                                                                                                                    | Yes (workspace-level + OAuth per-user)             |
| Semantic layer awareness        | No                                                                                                                                               | Yes (dbt MetricFlow, Cube, Snowflake, Databricks)  |

**The scheduling gap is closed in spirit but not in distribution.** Hermetic now has a real cron scheduler — a dashboard you built last week refreshes itself every Monday morning without you opening the tab. What it doesn't have (yet) is the distribution layer around it: no email, no Slack, no embed. The scheduled run produces an updated artifact on the local machine; you still have to open Hermetic to see it.

**Persistent history is also new** — closes a separate gap where session history vanished on restart. Now every analysis (generated code, results, visualizations) is on disk, browsable from a dedicated page, with one-click restore or re-run against fresh data.

**Hex still wins decisively on team collaboration and stakeholder distribution.** Hermetic remains single-user and local-first by design.

---

## Export & Distribution

| Feature                      | Hermetic                        | Hex              |
| ---------------------------- | ------------------------------- | ---------------- |
| PDF                          | Yes (themed, multi-page A4)     | Yes              |
| DOCX (Word)                  | Yes (landscape, embedded image) | No               |
| PPTX (PowerPoint)            | Yes (single 9×6.5 slide)        | No               |
| PNG (individual charts)      | Yes (2× pixel ratio)            | Yes              |
| CSV (table data)             | Yes (Papa Parse export)         | Yes              |
| XLSX (multi-sheet, styled)   | Yes                             | No               |
| Code download (Python / SQL) | Yes (Artifacts panel)           | Yes (Git export) |
| Shareable links              | No                              | Yes              |
| Scheduled email reports      | No                              | Yes              |
| Slack integration            | No                              | Yes              |
| Notion / Confluence embed    | No                              | Yes              |
| Signed embed (no Hex chrome) | No                              | Yes              |

**Unchanged from April.** Hermetic still wins on document export; Hex still wins on automated distribution.

---

## Code & Transparency

| Feature                   | Hermetic                                                                      | Hex                                    |
| ------------------------- | ----------------------------------------------------------------------------- | -------------------------------------- |
| View generated SQL        | Yes (Artifacts panel, syntax-highlighted)                                     | N/A (user / agent writes SQL)          |
| View generated Python     | Yes (full code, downloadable)                                                 | N/A (user / agent writes Python)       |
| View computed data tables | Yes (Artifacts panel, exportable as CSV/XLSX)                                 | Yes (cell outputs)                     |
| **Edit generated code**   | **Yes (new — edit Python or SQL in the Artifacts panel, re-runs downstream)** | Yes (full cell editing + Magic Edit)   |
| Notebook IDE              | No (AI-generated only, edit-and-rerun for single-artifact tweaks)             | Yes (full notebook with cells)         |
| SQL cells                 | No (AI generates SQL; edit-and-rerun on the generated SQL only)               | Yes (first-class)                      |
| Python cells              | No (AI generates Python; edit-and-rerun on the generated Python only)         | Yes (full environment)                 |
| R support                 | No                                                                            | Yes                                    |
| Custom pip packages       | Sandbox-constrained                                                           | pip install anything (Team/Enterprise) |
| Reusable logic            | No                                                                            | Yes (Components, Magic templates)      |
| dbt-aware code-gen        | Yes (column descriptions enrich prompt context)                               | Yes (full dbt docs)                    |
| Inline typeahead          | No                                                                            | Yes (context-aware completions)        |

**Edit-and-rerun is the right shape for Hermetic's audience.** It doesn't try to be a notebook — there are no cells, no kernels, no execution graph. But when the generated SQL or Python is 90% right and you want to fix one filter or rename a column, you open the editor, change the line, and the pipeline re-runs everything downstream without re-asking the LLM. That's enough for the non-technical user who occasionally needs to nudge the result without rewriting the whole analysis.

**Hex still wins on full code flexibility** — IDE, R, dbt-aware autocomplete, package install. **Hermetic still wins on transparency** — every artifact the AI generated is inspectable, editable, and downloadable.

---

## Privacy & Deployment

| Feature                    | Hermetic                            | Hex                                                 |
| -------------------------- | ----------------------------------- | --------------------------------------------------- |
| Self-hosted                | Yes                                 | No (single-tenant Enterprise hosting only)          |
| Fully offline / air-gapped | Yes (Docker + local LLM)            | No                                                  |
| Data stays on-premise      | Yes (always)                        | No (SQL runs on your warehouse, Python runs on Hex) |
| LLM never sees row data    | Yes (schema + stats only)           | No (data flows through AI for code-gen + execution) |
| Open source                | Yes (MIT)                           | No (proprietary)                                    |
| No vendor lock-in          | Yes (standard formats, JSON-Render) | No (proprietary notebook format)                    |
| BYO LLM                    | Yes (any of 7 providers + local)    | Limited (Enterprise only)                           |
| SOC 2 compliance           | N/A (self-hosted)                   | Yes (Type II, Team / Enterprise)                    |
| SSO / SAML                 | No                                  | Enterprise tier                                     |
| Audit logs                 | No                                  | Enterprise tier                                     |
| VPC / Private Link         | No                                  | Enterprise tier                                     |
| GDPR / HIPAA               | N/A (self-hosted)                   | GDPR yes; HIPAA Enterprise                          |

**Unchanged from April.** Hermetic still wins on privacy and control; Hex still wins on enterprise compliance for organizations needing a managed cloud platform.

---

## Pricing Comparison (May 2026)

|                            | Hermetic          | Hex Community | Hex Professional   | Hex Team               | Hex Enterprise |
| -------------------------- | ----------------- | ------------- | ------------------ | ---------------------- | -------------- |
| **Price**                  | Free (OSS)        | $0            | ~$36/editor/mo     | ~$75/editor/mo         | Custom         |
| Editors                    | Unlimited         | 1             | Individual / small | Full teams             | Org-wide       |
| Compute                    | Your hardware     | Limited       | Medium included    | Medium + pay-as-you-go | Custom         |
| Notebook Agent             | N/A               | Limited       | Yes                | Yes                    | Yes            |
| Scheduled runs             | Yes (free)        | No            | Yes                | Yes                    | Yes            |
| SSO                        | N/A               | No            | No                 | No                     | Yes            |
| Published apps             | N/A               | Limited       | Yes                | Yes                    | Yes            |
| dbt / semantic-layer cells | Descriptions only | Yes           | Yes                | Yes                    | Yes            |
| BYO LLM                    | Yes               | No            | No                 | No                     | Limited        |

**Hermetic's cost advantage is now wider on the scheduling axis.** Scheduled runs used to require Hex Professional ($36/editor/mo); they're now free on Hermetic. A team of 10 editors on Hex Team is ~$750/month or $9,000/year. Hermetic costs $0 plus your own compute. The tradeoff remains: self-hosting responsibility, no collaboration, no stakeholder distribution.

---

## What's New Since the Previous Version of This Comparison

**On the Hermetic side (since 2026-04-25):**

- **Snowflake connector** — inline + saved connection forms, dialect-aware SQL prompts, per-warehouse tab and color code in the UI. Closes the biggest warehouse gap.
- **Databricks connector** — `@databricks/sql` driver, SQL warehouse + personal access token auth.
- **Investigate agent** — multi-step analysis. Planner decomposes a question into 3–7 sub-questions, orchestrator runs independents in parallel waves and dependents serially, composer synthesizes one unified dashboard. Privacy posture unchanged (planner sees schema + stats only).
- **Scheduled dashboard runs** — node-cron under the hood, schedule popover anchored to the dashboard toolbar, schedule pills on saved-viz cards with edit/delete in place.
- **Persistent analysis history** — every analysis auto-saves to disk (generated code, results, visualizations), survives restarts, with a dedicated history page and one-click restore or re-run against fresh data.
- **Edit-and-rerun** on the generated Python or SQL — edit in the code editor, server skips the generation step for that artifact and re-runs everything downstream.
- **Interactive pivot tables** — sort, drill-through, drill-down, cross-filter with other widgets, aggregator switcher, heatmap mode, multi-value / multi-aggregator support.
- **Multi-retry with reflection** — up to 3 retries on failed code execution; after 2 failures the model gets the full failed-attempt history plus a reflection prompt instead of just the original.
- **Suggested follow-up questions** — inline pills after each analysis suggest the next obvious question.
- **dbt metadata enrichment** — column-level descriptions pulled into the LLM context alongside the warehouse schema.
- **Chart reliability pass across all 32 types** — charts auto-unwrap nested `{data, x_key, y_keys}` objects, line/area auto-detect long-format and pivot client-side, legends size from actual label lengths, labels truncate with tooltips, WCAG-compliant font sizes throughout, every chart supports full-height expanded rendering.
- **Warehouse pipeline fixes** — BigQuery LIKE-escape correction, ClickHouse Decimal→Float64 casts, single-column CSV handling, DuckDB `read_csv` explicit delimiters, Python prelude patches for `duckdb.sql` / `json.dump` NaN / `DataFrame.corr` numeric-only.

**On the Hex side:** Hex's public roadmap continues to advance the Notebook Agent, Threads, semantic-model integrations, and enterprise data-source connectors. Specific feature claims in this doc are carried forward from the 2026-04-25 baseline; consult the Hex changelog for net-new features since then.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **question to dashboard in seconds** with zero coding
- You want a **multi-step deep-dive** ("why did X spike?") without orchestrating it yourself — **Investigate** does the decomposition
- **Data privacy is non-negotiable** (air-gapped, on-prem, regulated industries)
- You want the **LLM to never see your data** (schema-only context)
- You need **32 chart types selected automatically** by AI, including specialized ones (Sankey, SHAP, ROC, deck.gl 3D maps, candlestick) and **interactive pivot tables**
- You want **rich document exports** (PowerPoint, Word, multi-sheet styled Excel)
- You want to **bring your own LLM** or run models locally (Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)
- You need **Parquet / DuckDB for big-local data** without uploading
- You need **scheduled dashboard refreshes** but don't need email/Slack distribution
- You connect to **Postgres, BigQuery, ClickHouse, Snowflake, Databricks, Trino, or Hive** and want dialect-aware SQL generation
- You're a **solo analyst or small team** without collaboration needs
- You want **zero vendor lock-in** and full control

### Choose Hex when:

- You need a **collaborative analytics platform for a data team** with multiplayer editing, threads, version history
- You want to **build, version, and publish interactive web apps** with custom theming and signed embeds
- You need warehouse coverage beyond Hermetic's seven (MySQL, SQL Server, Oracle, Athena, MotherDuck, etc.) or OAuth-per-user for Snowflake / Databricks / BigQuery
- You want a **full Python / R / SQL IDE** with Magic, Notebook Agent, and inline typeahead
- You need **deep semantic-layer integration** (dbt MetricFlow, Cube, Snowflake Semantic Views, Databricks Metric Views)
- You need **scheduled reports with email / Slack / embed distribution** to stakeholders
- You need **enterprise compliance** (SOC 2, SSO, audit logs, VPC, HIPAA on Enterprise)

### The Fundamental Difference

**Hermetic** is an **AI-first, single-shot dashboard generator** with an agentic deep-dive mode. One question produces a complete, styled, multi-component interactive dashboard — and the LLM never sees a single row of your data. For complex questions, Investigate decomposes them into sub-steps without you having to. It replaces the analyst workflow for routine questions and a meaningful fraction of exploratory ones.

**Hex** is an **AI-augmented notebook + app platform** that pairs a full SQL/Python/R IDE with the Notebook Agent and Magic features. The AI is a powerful collaborator inside a code-first environment built for teams.

They still serve different workflows, but the gap is narrower than in April. Hermetic is for "give me the answer — and if it's a hard question, do the multi-step analysis yourself." Hex is for "help me find — and ship — the answer with my team."

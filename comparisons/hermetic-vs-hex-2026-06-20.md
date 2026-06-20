# Hermetic vs Hex.tech — Competitive Feature Comparison

_Last updated: 2026-06-20_

_Previous versions of this comparison: [2026-05-31](./hermetic-vs-hex-2026-05-31.md), [2026-04-25](./hermetic-vs-hex-2026-04-25.md), [2026-03-24](./hermetic-vs-hex.md). This update reflects further changes on the Hermetic side: per-analysis LLM cost tracking (always-on footer, per-day CSV log, `/cost` page), a broad LLM cost optimization pass (prompt caching, cheaper models, fewer retries, lazy cells), the native chart library expanded from 32 to 57 AI-selected types, an Investigate **Notebook mode** (cell-based view exportable to Markdown/HTML/PDF/Slides), output styles consolidated from 6 to 4 (Dashboard, Brief, Report, Deep dive), and an onboarding/landing redesign. Hex-side claims and pricing are carried forward unchanged from the 2026-05-31 baseline._

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

| Feature                                      | Hermetic                                                | Hex                                                 |
| -------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| CSV upload                                   | Yes (100MB)                                             | Yes                                                 |
| Excel (multi-sheet + relationship detection) | Yes (auto-detects cross-sheet FKs)                      | Yes (basic upload)                                  |
| GeoJSON / JSON native                        | Yes (auto geometry detection)                           | JSON yes; GeoJSON via Python                        |
| Parquet files (single + Hive-partitioned)    | Yes (DuckDB-backed, zero-copy bind-mount)               | Yes                                                 |
| Local file browser                           | Yes (browse host filesystem from sandbox)               | No                                                  |
| PostgreSQL / Redshift / Neon / Supabase      | Yes (PG-wire compatible)                                | Yes                                                 |
| BigQuery (incl. BigQuery DataFrames)         | Yes                                                     | Yes (native + BigFrames pushdown)                   |
| Snowflake                                    | Yes (inline + saved connections, dialect-aware SQL)     | Yes (native + Snowpark pushdown)                    |
| Databricks                                   | Yes (`@databricks/sql` driver, SQL warehouse + token)   | Yes (added Oct 2025, incl. Unity Catalog)           |
| ClickHouse                                   | Yes                                                     | Yes                                                 |
| Trino / Starburst                            | Yes                                                     | Yes                                                 |
| Hive                                         | Yes                                                     | Via Trino                                           |
| MotherDuck / DuckDB                          | DuckDB in-sandbox                                       | Yes                                                 |
| MySQL / SQL Server / Oracle                  | No                                                      | Yes                                                 |
| Athena / AlloyDB                             | AlloyDB via PG-wire                                     | Yes                                                 |
| dbt metadata enrichment                      | Yes (column-level descriptions pulled into LLM context) | Yes (deep — schema enrichment, semantic-layer cell) |
| dbt / Cube / Snowflake Semantic Views        | No (descriptions only)                                  | Yes (semantic-model awareness across all four)      |
| Databricks Unity Catalog Metric Views        | No                                                      | Yes                                                 |
| API / HTTP sources                           | No                                                      | Via Python                                          |
| OAuth-per-user data connections              | No                                                      | Yes (Snowflake, Databricks, BigQuery)               |
| SSH tunneling                                | No                                                      | Yes                                                 |

**What changed:** no warehouse changes this cycle — Hermetic still ships first-class connectors for all seven warehouses (PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, Hive) with inline + saved connection forms, per-warehouse tabs and color codes, and dialect-aware SQL-generation prompts. dbt metadata enrichment remains: if a dbt project is wired up, column descriptions flow into the same context as the warehouse schema.

**Hex still wins on warehouse breadth and semantic-layer depth** — MySQL/SQL Server/Oracle/Athena, OAuth-per-user, SSH tunneling, and full semantic-model awareness (dbt MetricFlow, Cube, Snowflake Semantic Views, Databricks Metric Views) remain Hex-only. **Hermetic still wins on file-format intelligence and zero-copy ingestion** — Parquet folders bind-mount read-only into the sandbox, so terabyte-scale local data never copies, and Excel cross-sheet FK detection is unique.

---

## AI / LLM Capabilities

| Feature                                  | Hermetic                                                                                                                                                                                      | Hex (Magic + Notebook Agent)                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| NL to complete dashboard                 | Yes (one prompt → multi-widget JSON-Render spec)                                                                                                                                              | Partial (Notebook Agent builds full notebooks/apps step-by-step) |
| NL to SQL                                | Yes (dialect-aware, cross-table JOINs, per-warehouse prompt guidance)                                                                                                                         | Yes (Magic SQL, semantic-layer aware)                            |
| NL to Python                             | Yes (generates + executes blind)                                                                                                                                                              | Yes (Magic Python in notebook cells)                             |
| NL to R                                  | No                                                                                                                                                                                            | Yes                                                              |
| NL to chart                              | Yes (auto-selects from 57 types)                                                                                                                                                              | Yes (Magic Chart + Notebook Agent chart-cell generation)         |
| Inline code completion (typeahead)       | No                                                                                                                                                                                            | Yes (context-aware, schema-aware)                                |
| Edit-and-rerun on generated code         | Yes (edit Python or SQL in the code editor, server skips that step and re-runs downstream)                                                                                                    | Yes (Magic Edit/Debug, plus direct cell editing)                 |
| Code explain / debug                     | No                                                                                                                                                                                            | Yes (Magic Explain, Magic Debug)                                 |
| Multi-step agentic analysis              | Yes (Investigate: planner decomposes into 3–7 sub-questions, orchestrator runs parallel waves + serial deps, composer synthesizes one dashboard)                                              | Yes (Notebook Agent — autonomous multi-cell workflow)            |
| **Investigate Notebook mode**            | **Yes (new — render the multi-step investigation as a cell-based notebook, each step's question/code/result a cell, exportable to Markdown/HTML/PDF/Slides)**                                 | Yes (Notebook Agent output is a notebook by default)             |
| Failure recovery (retry with reflection) | Yes (retries on failed code execution; the model gets failed-attempt history + a reflection prompt)                                                                                           | Notebook Agent retries with cell context                         |
| Multi-provider LLM                       | Yes (7: Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)                                                                                                                    | No (Hex chooses provider; some BYO LLM on Enterprise)            |
| Local / offline LLM                      | Yes (MLX, llama.cpp, Ollama with curated 8/16/24/48GB tiers)                                                                                                                                  | No                                                               |
| Schema-aware code-gen                    | Yes (column types, distributions, correlations, FK relationships, dbt descriptions)                                                                                                           | Yes (warehouse schema, dbt docs, project execution graph)        |
| Output style control                     | Yes (4: Dashboard, Brief, Report, Deep dive)                                                                                                                                                  | No (single notebook/app format)                                  |
| **Per-analysis LLM cost tracking**       | **Yes (new — usage-reporting middleware captures the whole fan-out; always-on cost footer, per-day CSV log, `/cost` page + `GET /api/cost`)**                                                 | No (compute is bundled into the subscription)                    |
| **Prompt caching + cost optimization**   | **Yes (new — Anthropic ephemeral cacheControl on large static system prompts (~90% input discount on hits), Sonnet for heavy work + Haiku classifier, fewer retries, lazy cell composition)** | Provider-managed (not user-visible)                              |
| Drill-down re-analysis                   | Yes (click chart segment → new AI analysis with filtered context)                                                                                                                             | Manual re-query via Magic                                        |
| Follow-up / conversation context         | Yes (server-side conversation cache — question + code + result schema per turn)                                                                                                               | Yes (Threads, Magic context within project)                      |
| Suggested follow-up questions            | Yes (inline pills after each analysis suggest the next obvious question)                                                                                                                      | Yes (suggested explorations)                                     |
| Suggested initial questions              | Yes (LLM-generated from schema on data load)                                                                                                                                                  | Yes                                                              |
| Methodology disclosure                   | Yes (plain-English summary of rows, columns, ops on every analysis)                                                                                                                           | Visible in cell outputs / generated code                         |
| Schema-only privacy mode                 | Yes — LLM never sees data values, only schema + statistics                                                                                                                                    | No (data flows through Hex's AI infra)                           |
| Verifiable outputs (audit trail)         | Yes (Artifacts panel: SQL + Python + computed tables, downloadable)                                                                                                                           | Yes (every AI action visible as cells + version history)         |

**Cost is now first-class — and only Hermetic exposes it.** Every LLM call is wrapped in usage-reporting middleware backed by an AsyncLocalStorage accumulator, so the entire fan-out — code-gen, retries, planner, sub-questions, compose — is captured with zero call-site threading. It surfaces three ways: an always-mounted cost footer (last-analysis + running session), a per-day CSV at `data/cost/<YYYY-MM-DD>.csv` (timestamp, dataset, question, mode, models, llm_calls, token buckets, cost_usd), and a `/cost` page with per-dataset breakdown linked from Settings. Token buckets are priced via hand-maintained Anthropic rates; local/unknown models report $0 but still track tokens. This is a privacy-preserving, fully-local alternative to opaque cloud compute billing.

**The cost-optimization pass makes Investigate cheaper to run.** Anthropic ephemeral `cacheControl` now caches the large static system prompts (code-gen prompt + JSON-Render catalog) that every compose call re-sends, for roughly a 90% input discount on cache hits within the 5-minute TTL; the heavy work runs on Sonnet while the classifier runs on Haiku; retries are fewer and cells compose lazily. The biggest wins land on Investigate's many-call fan-out.

**Investigate now has a notebook form factor too.** The multi-step investigation can render as a cell-based notebook (each step's question, code, and result as a cell) and export to Markdown, HTML, PDF, or Slides — in addition to the unified-dashboard form. The notebook-vs-dashboard distinction that used to separate Hermetic from Hex's Notebook Agent is now a toggle inside Hermetic.

**The Investigate gap closed last cycle.** Hermetic's Investigate decomposes a fuzzy question ("why did churn spike in Q1?") into a multi-step analysis in a single streaming response — planner sees schema + stats only, orchestrator runs sub-questions in parallel waves where independent and serially where dependent, composer synthesizes a unified dashboard. With Notebook mode, the two products now converge on form factor as well as capability.

**Hex still wins on iterative code-craft** — Magic Explain/Debug, R support, inline typeahead, and the multi-turn notebook editing loop. **Hermetic still wins on AI autonomy, privacy, and cost transparency** — one question → styled dashboard with no row data leaving the host, 7 LLM providers including fully-local inference, and an exact dollar figure for every analysis.

---

## Visualization

| Feature                                                                                  | Hermetic                                                                                                                                | Hex                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Native chart types                                                                       | **57 (new — AI-selected from JSON-Render spec, up from 32)**                                                                            | ~14 built-in chart-cell types                |
| No-code chart creation                                                                   | AI-driven (fully automatic)                                                                                                             | Drag-and-drop chart builder + Magic Chart    |
| Code-based charts                                                                        | Sandbox Python (matplotlib, plotly, seaborn)                                                                                            | Full Python/R environment (any library)      |
| Expanded full-height mode (all charts)                                                   | Yes (every chart fills available height when expanded)                                                                                  | Yes                                          |
| WCAG-compliant typography                                                                | Yes (12px UI, 11px chart labels minimum throughout)                                                                                     | Yes                                          |
| Robust data shape handling                                                               | Yes (charts auto-unwrap nested `{data, x_key, y_keys}` objects, line/area auto-detect long-format)                                      | N/A (user writes the code)                   |
| **Basic Charts**                                                                         |                                                                                                                                         |                                              |
| Bar (grouped, stacked, horizontal)                                                       | Yes                                                                                                                                     | Yes                                          |
| Line (multi-series, stepped)                                                             | Yes                                                                                                                                     | Yes                                          |
| Area (stacked, overlaid)                                                                 | Yes                                                                                                                                     | Yes                                          |
| Pie / Donut                                                                              | Yes                                                                                                                                     | Yes                                          |
| Scatter (with regression)                                                                | Yes                                                                                                                                     | Yes                                          |
| Histogram                                                                                | Yes                                                                                                                                     | Yes                                          |
| **Distribution**                                                                         |                                                                                                                                         |                                              |
| Box Plot, Violin, Ridgeline, Beeswarm                                                    | Yes (native)                                                                                                                            | Box/Histogram native; others via Python      |
| **Statistics (new)**                                                                     |                                                                                                                                         |                                              |
| Pareto, QQ, ECDF, Kaplan–Meier survival, forest, control/SPC, correlogram, error bars/CI | **Yes (new — native)**                                                                                                                  | Via Python                                   |
| **Hierarchical**                                                                         |                                                                                                                                         |                                              |
| Treemap, Sunburst, Dendrogram                                                            | Yes (native)                                                                                                                            | Treemap native; others via Python            |
| **Network & Flow**                                                                       |                                                                                                                                         |                                              |
| Sankey, Chord, Stream, Network graph                                                     | Yes (native)                                                                                                                            | Via Python                                   |
| **Comparison & Ranking**                                                                 |                                                                                                                                         |                                              |
| Bump, Dumbbell, Slope, Bullet, Waterfall, Marimekko, Radar, Funnel, Gauge, Dual-axis     | Yes (native)                                                                                                                            | Via Python                                   |
| **ML / Statistical**                                                                     |                                                                                                                                         |                                              |
| Confusion matrix, ROC, SHAP beeswarm, Decision tree                                      | Yes (native)                                                                                                                            | Via Python                                   |
| Calibration, Lift/Gain, Partial dependence, Silhouette                                   | **Yes (new — native)**                                                                                                                  | Via Python                                   |
| Parallel coordinates                                                                     | Yes                                                                                                                                     | Via Python                                   |
| **Financial**                                                                            |                                                                                                                                         |                                              |
| Candlestick (OHLC)                                                                       | Yes (native)                                                                                                                            | Via Python                                   |
| **Scientific & Temporal (new)**                                                          |                                                                                                                                         |                                              |
| Contour, Ternary, Population pyramid, Gantt, Cohort grid, Quiver, Wind rose              | **Yes (new — native)**                                                                                                                  | Via Python                                   |
| **Geographic**                                                                           |                                                                                                                                         |                                              |
| 2D Map (markers + choropleth)                                                            | Yes (MapLibre GL)                                                                                                                       | Via Folium / Plotly / Python                 |
| 3D Globe (arcs + points, arc filtering)                                                  | Yes (react-globe.gl)                                                                                                                    | No                                           |
| 3D Deck.gl (hexagon, column, arc, heatmap, scatter)                                      | Yes (5 layer types, click/hover interactivity)                                                                                          | No                                           |
| **3D Plots**                                                                             |                                                                                                                                         |                                              |
| Scatter3D / Surface3D                                                                    | Yes (Plotly 3D)                                                                                                                         | Via Python                                   |
| **Calendar**                                                                             |                                                                                                                                         |                                              |
| Calendar heatmap                                                                         | Yes (GitHub-style)                                                                                                                      | Via Python                                   |
| **Data Display**                                                                         |                                                                                                                                         |                                              |
| Data table (sort, filter, paginate)                                                      | Yes                                                                                                                                     | Yes (with sparklines)                        |
| Stat cards / KPI                                                                         | Yes (StatCard + TrendIndicator + format hints)                                                                                          | Yes (Single value / Big Number cell)         |
| Interactive pivot tables                                                                 | Yes (sort, drill-through, drill-down, cross-filter with other widgets, aggregator switcher, heatmap mode, multi-value/multi-aggregator) | Yes (Pivot cell — Notebook Agent can author) |
| Conditional formatting                                                                   | Tables + pivot heatmap mode                                                                                                             | Yes                                          |

**The chart library jumped from 32 to 57 native types.** New since 32: a full **statistics** family (Pareto, QQ, ECDF, Kaplan–Meier survival, forest, control/SPC, correlogram, error bars/CI), more **ML** charts (calibration, lift/gain, partial dependence, dendrogram, silhouette, network graph), **financial/KPI** additions (dual-axis, funnel, gauge, bullet, waterfall, marimekko), **scientific/temporal** charts (contour, ternary, population pyramid, Gantt, cohort grid, quiver, wind rose), and **3D** (Scatter3D, Surface3D, Globe3D, deck.gl maps). All are AI-selected with no code.

**Hermetic still wins on out-of-the-box chart diversity** — 57 native types AI-selected with no code, including specialized analytical charts (Sankey, SHAP, ROC, Kaplan–Meier, deck.gl 3D maps, candlestick) that Hex requires Python for. **Hex still wins on unlimited customization** — any Python or R library, fully programmable cells.

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

**Unchanged from May.** Hex's App Builder is still a flagship product. Hermetic still composes the entire interactive layout from one question with zero manual building.

---

## Collaboration, Sharing & Operations

| Feature                       | Hermetic                                                                                                                                       | Hex                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Real-time multiplayer editing | No                                                                                                                                             | Yes (Google Docs-style)                            |
| Comments / threads            | No                                                                                                                                             | Yes (Threads on cells, also AI-aware)              |
| Version history               | Yes (per-viz versions)                                                                                                                         | Yes (full, with restore/fork)                      |
| Git integration               | No                                                                                                                                             | Yes (GitHub, GitLab; Enterprise)                   |
| Role-based access (RBAC)      | No                                                                                                                                             | Yes (Admin, Editor, Viewer, Publisher, App user)   |
| Workspace organization        | No                                                                                                                                             | Yes (Collections, status workflows)                |
| Published apps                | No                                                                                                                                             | Yes (standalone web apps, dashboards)              |
| Scheduled runs (cron)         | Yes (node-cron scheduler, schedule popover anchored to the dashboard toolbar, schedule pills on saved-viz cards, edit/delete in place)         | Yes (with email/Slack delivery)                    |
| Persistent analysis history   | Yes (auto-saves every analysis to disk; history survives restarts; dedicated history page; restore or re-run against fresh data)               | Yes (project history + version control)            |
| **Cost & observability**      | **Yes (new — per-analysis LLM cost footer, per-day CSV cost log, `/cost` page + `GET /api/cost` with per-dataset breakdown, all fully local)** | Compute usage visible in admin billing (bundled)   |
| Embed in other tools          | No                                                                                                                                             | Yes (signed embedding, custom theming, headerless) |
| API-triggered runs            | No                                                                                                                                             | Yes (REST API)                                     |
| Email / Slack delivery        | No (scheduled runs are local-only)                                                                                                             | Yes                                                |
| Review workflows              | No                                                                                                                                             | Yes (Draft / In Review / Published statuses)       |
| Shared data connections       | No (per-user)                                                                                                                                  | Yes (workspace-level + OAuth per-user)             |
| Semantic layer awareness      | No                                                                                                                                             | Yes (dbt MetricFlow, Cube, Snowflake, Databricks)  |

**Cost observability is the new operational capability.** Hermetic now records the exact LLM cost of every analysis to a per-day CSV and surfaces running totals in an always-on footer and a dedicated `/cost` page (with a `GET /api/cost` endpoint and a per-dataset breakdown). It is fully local — nothing leaves the host — and is a privacy-preserving counterpart to cloud compute billing, where the per-question cost is bundled and opaque.

**Scheduling and persistent history carry forward** from the May release — a real cron scheduler refreshes a saved dashboard on its own, and every analysis (generated code, results, visualizations) is on disk and browsable. What scheduling still lacks is the distribution layer: no email, no Slack, no embed — the scheduled run produces an updated artifact on the local machine.

**Hex still wins decisively on team collaboration and stakeholder distribution.** Hermetic remains single-user and local-first by design.

---

## Export & Distribution

| Feature                           | Hermetic                                                          | Hex                 |
| --------------------------------- | ----------------------------------------------------------------- | ------------------- |
| PDF                               | Yes (themed, multi-page A4)                                       | Yes                 |
| DOCX (Word)                       | Yes (landscape, embedded image)                                   | No                  |
| PPTX (PowerPoint)                 | Yes (single 9×6.5 slide)                                          | No                  |
| PNG (individual charts)           | Yes (2× pixel ratio)                                              | Yes                 |
| CSV (table data)                  | Yes (Papa Parse export)                                           | Yes                 |
| XLSX (multi-sheet, styled)        | Yes                                                               | No                  |
| **Slides (Investigate notebook)** | **Yes (new — Investigate Notebook mode exports to a slide deck)** | Yes (App / publish) |
| Code download (Python / SQL)      | Yes (Artifacts panel)                                             | Yes (Git export)    |
| Shareable links                   | No                                                                | Yes                 |
| Scheduled email reports           | No                                                                | Yes                 |
| Slack integration                 | No                                                                | Yes                 |
| Notion / Confluence embed         | No                                                                | Yes                 |
| Signed embed (no Hex chrome)      | No                                                                | Yes                 |

**Investigate Notebook mode adds export breadth.** A multi-step investigation rendered as a notebook now exports to Markdown, HTML, PDF, or Slides in addition to Hermetic's existing document exports. Hermetic still wins on document export; Hex still wins on automated distribution.

---

## Code & Transparency

| Feature                   | Hermetic                                                                                                            | Hex                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| View generated SQL        | Yes (Artifacts panel, syntax-highlighted)                                                                           | N/A (user / agent writes SQL)          |
| View generated Python     | Yes (full code, downloadable)                                                                                       | N/A (user / agent writes Python)       |
| View computed data tables | Yes (Artifacts panel, exportable as CSV/XLSX)                                                                       | Yes (cell outputs)                     |
| Edit generated code       | Yes (edit Python or SQL in the Artifacts panel, re-runs downstream)                                                 | Yes (full cell editing + Magic Edit)   |
| **Notebook view**         | **Yes (new — Investigate renders as a cell-based notebook, exportable; still AI-generated, not a hand-edited IDE)** | Yes (full notebook with cells)         |
| SQL cells                 | No (AI generates SQL; edit-and-rerun on the generated SQL only)                                                     | Yes (first-class)                      |
| Python cells              | No (AI generates Python; edit-and-rerun on the generated Python only)                                               | Yes (full environment)                 |
| R support                 | No                                                                                                                  | Yes                                    |
| Custom pip packages       | Sandbox-constrained                                                                                                 | pip install anything (Team/Enterprise) |
| Reusable logic            | No                                                                                                                  | Yes (Components, Magic templates)      |
| dbt-aware code-gen        | Yes (column descriptions enrich prompt context)                                                                     | Yes (full dbt docs)                    |
| Inline typeahead          | No                                                                                                                  | Yes (context-aware completions)        |

**Edit-and-rerun is still the right shape for Hermetic's audience.** It doesn't try to be a notebook IDE — there are no kernels, no hand-authored execution graph. But when the generated SQL or Python is 90% right and you want to fix one filter or rename a column, you open the editor, change the line, and the pipeline re-runs everything downstream without re-asking the LLM. The new Investigate Notebook mode adds a cell-based _view_ of a multi-step run (and an export), without turning Hermetic into a code-first IDE.

**Hex still wins on full code flexibility** — IDE, R, dbt-aware autocomplete, package install. **Hermetic still wins on transparency** — every artifact the AI generated is inspectable, editable, and downloadable, and now every analysis carries its exact LLM cost.

---

## Privacy & Deployment

| Feature                     | Hermetic                                                                                      | Hex                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Self-hosted                 | Yes                                                                                           | No (single-tenant Enterprise hosting only)          |
| Fully offline / air-gapped  | Yes (Docker + local LLM)                                                                      | No                                                  |
| Data stays on-premise       | Yes (always)                                                                                  | No (SQL runs on your warehouse, Python runs on Hex) |
| LLM never sees row data     | Yes (schema + stats only)                                                                     | No (data flows through AI for code-gen + execution) |
| **Local LLM cost tracking** | **Yes (new — per-analysis cost logged to local CSV + `/cost` page; nothing leaves the host)** | No (compute billing is cloud-side)                  |
| Open source                 | Yes (MIT)                                                                                     | No (proprietary)                                    |
| No vendor lock-in           | Yes (standard formats, JSON-Render)                                                           | No (proprietary notebook format)                    |
| BYO LLM                     | Yes (any of 7 providers + local)                                                              | Limited (Enterprise only)                           |
| SOC 2 compliance            | N/A (self-hosted)                                                                             | Yes (Type II, Team / Enterprise)                    |
| SSO / SAML                  | No                                                                                            | Enterprise tier                                     |
| Audit logs                  | No                                                                                            | Enterprise tier                                     |
| VPC / Private Link          | No                                                                                            | Enterprise tier                                     |
| GDPR / HIPAA                | N/A (self-hosted)                                                                             | GDPR yes; HIPAA Enterprise                          |

**Cost transparency reinforces the privacy story.** Hermetic now tracks LLM spend per analysis entirely on the host — a per-day CSV and a `/cost` page — so you can see exactly what each question cost without that telemetry going to a vendor. Hermetic still wins on privacy and control; Hex still wins on enterprise compliance for organizations needing a managed cloud platform.

---

## Pricing Comparison (June 2026)

|                                   | Hermetic                                         | Hex Community    | Hex Professional   | Hex Team                | Hex Enterprise |
| --------------------------------- | ------------------------------------------------ | ---------------- | ------------------ | ----------------------- | -------------- |
| **Price**                         | Free (OSS)                                       | $0               | ~$36/editor/mo     | ~$75/editor/mo          | Custom         |
| Editors                           | Unlimited                                        | 1                | Individual / small | Full teams              | Org-wide       |
| Compute                           | Your hardware                                    | Limited          | Medium included    | Medium + pay-as-you-go  | Custom         |
| **LLM / compute cost visibility** | Exact per-analysis cost (footer + CSV + `/cost`) | Bundled / opaque | Bundled / opaque   | Bundled + pay-as-you-go | Custom         |
| Notebook Agent                    | N/A                                              | Limited          | Yes                | Yes                     | Yes            |
| Scheduled runs                    | Yes (free)                                       | No               | Yes                | Yes                     | Yes            |
| SSO                               | N/A                                              | No               | No                 | No                      | Yes            |
| Published apps                    | N/A                                              | Limited          | Yes                | Yes                     | Yes            |
| dbt / semantic-layer cells        | Descriptions only                                | Yes              | Yes                | Yes                     | Yes            |
| BYO LLM                           | Yes                                              | No               | No                 | No                      | Limited        |

**Hermetic's cost advantage now comes with cost visibility.** Beyond being free (OSS) with scheduled runs included, Hermetic shows the exact dollar cost of every analysis — the per-day CSV and `/cost` page make LLM spend auditable line by line, and the cost-optimization pass (prompt caching, cheaper models) drives the per-question number down. By contrast, Hex compute is bundled into the subscription (with pay-as-you-go on Team) and the per-question cost is opaque. A team of 10 editors on Hex Team is ~$750/month or $9,000/year; Hermetic costs $0 plus your own compute, and you can see precisely what the LLM portion of that compute is. The tradeoff remains: self-hosting responsibility, no collaboration, no stakeholder distribution.

---

## What's New Since the Previous Version of This Comparison

**On the Hermetic side (since 2026-05-31):**

- **Per-analysis LLM cost tracking** — every LLM call is wrapped with usage-reporting middleware (an AsyncLocalStorage accumulator), so the whole fan-out (code-gen, retries, planner, sub-questions, compose) is captured with zero call-site threading. Surfaced three ways: an always-mounted cost footer (last-analysis + running session cost); a per-day CSV at `data/cost/<YYYY-MM-DD>.csv` with timestamp, dataset, question, mode, models, llm_calls, token buckets (noCache/cacheRead/cacheWrite/output) and cost_usd; and a `/cost` page + `GET /api/cost` with totals and a per-dataset breakdown, linked from Settings. Priced via hand-maintained Anthropic rates; local/unknown models report $0 but still track tokens. A privacy-preserving, fully-local alternative to opaque cloud compute billing.
- **LLM cost optimization** — prompt caching via Anthropic ephemeral `cacheControl` (~90% input discount on cache hits, 5-min TTL) on the large static system prompts every compose call re-sends (code-gen prompt + JSON-Render catalog prompt); cheaper models (Sonnet for heavy work, Haiku for the classifier); fewer retries; lazy cell composition. Largest wins on Investigate's many-call fan-out.
- **Chart library expanded from 32 to 57 native AI-selected types** — new statistics (Pareto, QQ, ECDF, Kaplan–Meier survival, forest, control/SPC, correlogram, error bars/CI), ML (calibration, lift/gain, partial dependence, dendrogram, silhouette, network graph), financial/KPI (dual-axis, funnel, gauge, bullet, waterfall, marimekko), scientific/temporal (contour, ternary, population pyramid, Gantt, cohort grid, quiver, wind rose), and 3D (Scatter3D, Surface3D, Globe3D, deck.gl maps).
- **Investigate Notebook mode** — the multi-step investigation can render as a cell-based notebook (each step's question, code, and result as a cell), exportable to Markdown, HTML, PDF, or Slides — in addition to the unified-dashboard form.
- **Output styles consolidated from 6 to 4** — Dashboard, Brief, Report, Deep dive. (Slides is now an export format, not a style.)
- **Onboarding/landing redesign** — privacy-forward hero ("the model writes the code — it never sees your rows"), a payoff preview showing real generated dashboards before upload, real drag-and-drop file upload, a prominent one-click sample dataset, and a trust strip (sealed/local · bring-your-own or local models · sandboxed execution).
- **Reliability** — generated code no longer crashes when local models emit hard-coded value assertions.

**On the Hex side:** Hex-side claims and pricing in this doc are carried forward unchanged from the 2026-05-31 baseline (Notebook Agent, Threads, semantic-model integrations, enterprise data-source connectors). Consult the Hex changelog for net-new features since then.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **question to dashboard in seconds** with zero coding
- You want a **multi-step deep-dive** ("why did X spike?") without orchestrating it yourself — **Investigate** does the decomposition, and can render as a dashboard or an exportable **notebook**
- **Data privacy is non-negotiable** (air-gapped, on-prem, regulated industries)
- You want the **LLM to never see your data** (schema-only context)
- You want to **see the exact LLM cost of every analysis** — always-on footer, per-day CSV, `/cost` page — fully local
- You need **57 chart types selected automatically** by AI, including specialized ones (Sankey, SHAP, ROC, Kaplan–Meier, deck.gl 3D maps, candlestick) and **interactive pivot tables**
- You want **rich document exports** (PowerPoint, Word, multi-sheet styled Excel) plus notebook exports (Markdown / HTML / PDF / Slides)
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

**Hermetic** is an **AI-first, single-shot dashboard generator** with an agentic deep-dive mode. One question produces a complete, styled, multi-component interactive dashboard — and the LLM never sees a single row of your data. For complex questions, Investigate decomposes them into sub-steps without you having to, and can present the result as a dashboard or an exportable notebook. It now also shows you exactly what each analysis cost. It replaces the analyst workflow for routine questions and a meaningful fraction of exploratory ones.

**Hex** is an **AI-augmented notebook + app platform** that pairs a full SQL/Python/R IDE with the Notebook Agent and Magic features. The AI is a powerful collaborator inside a code-first environment built for teams.

They still serve different workflows, but the gap continues to narrow. Hermetic is for "give me the answer — and if it's a hard question, do the multi-step analysis yourself, and tell me what it cost." Hex is for "help me find — and ship — the answer with my team."

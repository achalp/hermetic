# Hermetic vs Julius AI & Vizly — Competitive Feature Comparison

_Last updated: 2026-06-20_

_Previous versions of this comparison: [2026-04-25](./hermetic-vs-julius-vizly-2026-04-25.md), [un-dated original](./hermetic-vs-julius-vizly.md). This update reflects two waves of changes on the Hermetic side since April. **Wave 1 (Apr 25 → May 31):** Snowflake and Databricks connectors, the **Investigate** multi-step agent, scheduled dashboard runs, persistent analysis history, edit-and-rerun on generated Python/SQL, interactive pivot tables, multi-retry with reflection, suggested follow-up questions, and dbt metadata enrichment. **Wave 2 (May 31 → Jun 20):** per-analysis LLM cost tracking, LLM cost optimization (prompt caching + cheaper models), the chart library expanded from 32 to 57 native types, Investigate **Notebook mode** with Markdown/HTML/PDF/Slides export, a consolidated set of 4 output styles, an onboarding/landing redesign, and a reliability fix for hard-coded value assertions from local models. Several gaps from the April version are now closed. All Julius/Vizly-side claims and pricing are carried forward from the 2026-04-25 baseline._

These are the closest direct competitors to Hermetic in the "upload data, ask question, get visualization" category. Both are cloud-only SaaS products targeting individual analysts and researchers.

---

## Overview

| Category        | Hermetic                                                                                                 | Julius AI                                                     | Vizly                                        |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| **Core Model**  | Question → multi-widget dashboard, single shot; **Investigate** decomposes hard questions into sub-steps | Chat thread + agentic workflows (Bloom agents, Custom Agents) | Chat with pinnable charts, AI data analyst   |
| **Deployment**  | Self-hosted / local-first                                                                                | Cloud SaaS only                                               | Cloud SaaS only                              |
| **Pricing**     | Free (open source)                                                                                       | Free (15 msg/mo) → Plus → Pro $45/mo → Business → Enterprise  | Free → paid (limited public pricing)         |
| **Target User** | Privacy-conscious analyst, regulated industries                                                          | Students, researchers, business teams (Pro+ for warehouses)   | Casual data explorers, SPSS / academic users |
| **Open Source** | Yes (MIT)                                                                                                | No                                                            | No                                           |
| **Status**      | Active, frequent releases                                                                                | Active, expanded with Bloom agentic workflows                 | Active (Y Combinator, $500K seed, Montreal)  |
| **Privacy**     | Data + LLM context stay on your machine                                                                  | Cloud-processed; SOC 2 claimed                                | Cloud-processed                              |

---

## Data Sources

| Feature                         | Hermetic                                                          | Julius AI                                   | Vizly                  |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------- | ---------------------- |
| CSV                             | Yes (100MB)                                                       | Yes                                         | Yes                    |
| Excel (.xlsx)                   | Yes (multi-sheet + FK relationship detection)                     | Yes                                         | Yes                    |
| GeoJSON                         | Yes (native, auto geometry detection)                             | No                                          | No                     |
| JSON                            | Via GeoJSON path                                                  | Yes                                         | Yes                    |
| Parquet (single + Hive folders) | **Yes (DuckDB-backed, zero-copy bind-mount)**                     | No                                          | No                     |
| SPSS (.sav)                     | No                                                                | No                                          | Yes (a Vizly hallmark) |
| PDF table extraction            | No                                                                | Yes (uploads)                               | Yes                    |
| Google Sheets                   | No                                                                | Yes (via link or Google Drive connector)    | No                     |
| Local file browser (host fs)    | **Yes (bind-mounted into sandbox, read-only)**                    | No                                          | No                     |
| **Warehouse Connectors**        |                                                                   |                                             |                        |
| PostgreSQL                      | Yes                                                               | Yes (Pro+)                                  | No                     |
| BigQuery                        | Yes                                                               | Yes (Pro+)                                  | No                     |
| Snowflake                       | **Yes (new — inline + saved connections, dialect-aware SQL)**     | Yes (Pro+)                                  | No                     |
| Databricks                      | **Yes (new — SQL warehouse + token, dialect-aware SQL)**          | Yes (Pro+)                                  | No                     |
| MySQL                           | No                                                                | Yes (Pro+)                                  | No                     |
| SQL Server                      | No                                                                | Yes (Pro+)                                  | No                     |
| Supabase                        | Yes (PG-wire compatible)                                          | Yes (Pro+)                                  | No                     |
| ClickHouse                      | Yes                                                               | No                                          | No                     |
| Trino / Hive                    | Yes                                                               | No                                          | No                     |
| **App / SaaS Connectors**       |                                                                   |                                             |                        |
| Google Drive / OneDrive         | No                                                                | Yes                                         | No                     |
| Google Ads / Stripe             | No                                                                | Yes                                         | No                     |
| **AI behavior**                 |                                                                   |                                             |                        |
| Warehouse SQL generation        | Yes (dialect-aware across 7 warehouses, cross-table JOINs)        | Yes (semantic layer auto-built from schema) | No                     |
| **dbt metadata enrichment**     | **Yes (new — column-level descriptions pulled into LLM context)** | No                                          | No                     |
| Custom Agents / saved workflows | No                                                                | Yes (Pro+ — define analytical processes)    | No                     |

**Hermetic now leads on warehouse breadth among free tools** — 7 native warehouse connectors (PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, Hive) plus Parquet and local-file zero-copy ingestion. Snowflake and Databricks were both **No** in the April doc; both now ship with first-class connectors, inline + saved connection forms, and per-warehouse tabs and colors. **Julius still wins on SaaS sources** — Google Ads, Stripe, Drive, plus MySQL and SQL Server, but only on Pro and above. **Vizly wins on file-format niches** — SPSS and PDF table extraction.

---

## AI / LLM Capabilities

| Feature                                      | Hermetic                                                                                                                                                   | Julius AI                                                    | Vizly                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------- |
| NL to complete dashboard                     | Yes (multi-widget JSON-Render layout, one prompt)                                                                                                          | Partial (single-chart per message; Bloom agents chain steps) | No (single chart per message) |
| NL to chart                                  | Yes (auto-selects from 57 types)                                                                                                                           | Yes (~12 types)                                              | Yes (~8-10 types)             |
| NL to statistical analysis                   | Via generated Python (sandbox)                                                                                                                             | Yes (regression, hypothesis tests, forecasting)              | Basic                         |
| **Multi-step agentic analysis**              | **Yes (new — Investigate: planner decomposes into 3–7 sub-questions, orchestrator runs parallel waves + serial deps, composer synthesizes one dashboard)** | Yes (Bloom autonomous agents on Plus+)                       | Limited                       |
| Code generation                              | Yes (Python, visible + downloadable)                                                                                                                       | Yes (Python, visible + editable inline)                      | Yes (Python, visible)         |
| **Code editing**                             | **Yes (new — edit-and-rerun on generated Python or SQL; server skips that gen step and re-runs downstream)**                                               | Yes (edit generated code inline)                             | No                            |
| **Failure recovery (retry with reflection)** | **Yes (new — up to 3 retries; after 2 failures the model gets full failed-attempt history + a reflection prompt)**                                         | Limited                                                      | No                            |
| Multi-provider LLM                           | Yes (7 providers)                                                                                                                                          | No (Julius-managed model selection)                          | No                            |
| Local / offline LLM                          | Yes (MLX, llama.cpp, Ollama)                                                                                                                               | No                                                           | No                            |
| **Per-analysis LLM cost tracking**           | **Yes (new — live footer + per-day CSV log + `/cost` page with per-dataset breakdown; captures the whole fan-out including Investigate sub-questions)**    | No (opaque per-seat / credit billing)                        | No                            |
| Output styles / purpose modes                | **4 (Dashboard, Brief, Report, Deep dive — Slides is now an export format)**                                                                               | No (chat format only)                                        | No                            |
| Drill-down re-analysis                       | Yes (click chart segment → new analysis)                                                                                                                   | No                                                           | No                            |
| Follow-up questions                          | Yes (server-side conversation cache, 5 turns)                                                                                                              | Yes (chat thread)                                            | Yes (chat thread)             |
| Sandbox execution                            | Yes (Docker, Microsandbox microVM, E2B)                                                                                                                    | Yes (server-side sandbox)                                    | Yes (server-side sandbox)     |
| Schema-only privacy mode                     | **Yes — LLM never sees row values (planner included)**                                                                                                     | No (data flows through cloud)                                | No                            |
| Schema-aware code-gen                        | Yes (types, distributions, correlations, FK relationships, dbt descriptions)                                                                               | Yes (semantic layer of warehouse schema)                     | Basic                         |
| Methodology display                          | Yes (plain-English summary on every analysis)                                                                                                              | Visible in code                                              | Visible in code               |
| **Suggested follow-up questions**            | **Yes (new — inline pills after each analysis)**                                                                                                           | Limited                                                      | Limited                       |
| Suggested questions                          | Yes (LLM-generated from schema on file load)                                                                                                               | Limited                                                      | Limited                       |

**The agentic gap closes meaningfully.** Until this release Julius's Bloom agents were the standout autonomous-workflow feature. Hermetic's new **Investigate** does the same decomposition in a single streaming response — planner breaks the question into 3–7 sub-questions, orchestrator runs independents in parallel waves and dependents serially, composer synthesizes one unified dashboard — and the planner still only sees schema + statistics, never row values. **Hermetic wins on output composition, privacy, and transparency** — single-prompt multi-component dashboards, the LLM operates on schema only, and now a fully-local **per-analysis cost ledger** (footer, CSV, `/cost` page) replacing opaque per-seat billing. **Julius still wins on inline code editing within a chat workflow** and automatic semantic-layer construction over warehouse schemas.

---

## Visualization

| Feature                                            | Hermetic                                                                                                                       | Julius AI         | Vizly                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------- | --------------------- |
| Native chart types                                 | **57**                                                                                                                         | ~10-12            | ~8-10                 |
| **Basic Charts**                                   |                                                                                                                                |                   |                       |
| Bar / Line / Area / Pie / Scatter                  | Yes                                                                                                                            | Yes               | Yes                   |
| Histogram                                          | Yes                                                                                                                            | Yes               | Yes                   |
| **Distribution**                                   |                                                                                                                                |                   |                       |
| Box Plot                                           | Yes                                                                                                                            | Via code          | No                    |
| Violin / Ridgeline / Beeswarm                      | Yes                                                                                                                            | No                | No                    |
| **Statistical (new)**                              |                                                                                                                                |                   |                       |
| **Pareto / QQ / ECDF / correlogram**               | **Yes (new — native)**                                                                                                         | Via code          | No                    |
| **Error bars / CI / calibration / lift-gain**      | **Yes (new — native)**                                                                                                         | Via code          | No                    |
| **Kaplan–Meier survival / forest / control (SPC)** | **Yes (new — native)**                                                                                                         | Via code          | No                    |
| **Partial dependence / silhouette / dendrogram**   | **Yes (new — native)**                                                                                                         | Via code          | No                    |
| **Hierarchical**                                   |                                                                                                                                |                   |                       |
| Treemap / Sunburst                                 | Yes                                                                                                                            | No                | No                    |
| **Network & Flow**                                 |                                                                                                                                |                   |                       |
| Sankey / Chord / Stream                            | Yes                                                                                                                            | No                | No                    |
| **Network graph (new)**                            | **Yes (new — native)**                                                                                                         | No                | No                    |
| **Comparison**                                     |                                                                                                                                |                   |                       |
| Bump / Dumbbell / Bullet / Waterfall               | Yes                                                                                                                            | No                | No                    |
| Marimekko / Radar                                  | Yes                                                                                                                            | No                | No                    |
| **Funnel / Gauge / Dual-axis (new)**               | **Yes (new — native)**                                                                                                         | No                | No                    |
| **Geographic**                                     |                                                                                                                                |                   |                       |
| 2D Map (MapLibre)                                  | Yes                                                                                                                            | Via code (Folium) | No                    |
| 3D Globe (with arc filtering)                      | Yes                                                                                                                            | No                | No                    |
| Deck.gl 3D Maps (5 layers)                         | Yes                                                                                                                            | No                | No                    |
| **Wind rose / Quiver / Contour / Ternary (new)**   | **Yes (new — native)**                                                                                                         | No                | No                    |
| **3D Plots**                                       |                                                                                                                                |                   |                       |
| Scatter3D / Surface3D / **Globe3D**                | Yes (**Globe3D new**)                                                                                                          | Via code          | No                    |
| **ML / Statistical**                               |                                                                                                                                |                   |                       |
| ROC / Confusion Matrix / SHAP                      | Yes (native)                                                                                                                   | Via code          | No                    |
| Decision Tree / Parallel Coordinates               | Yes (native)                                                                                                                   | No                | No                    |
| **Financial**                                      |                                                                                                                                |                   |                       |
| Candlestick                                        | Yes                                                                                                                            | Via code          | No                    |
| **Calendar / Cohort**                              |                                                                                                                                |                   |                       |
| Calendar heatmap                                   | Yes                                                                                                                            | No                | No                    |
| **Cohort grid / Gantt / Population pyramid (new)** | **Yes (new — native)**                                                                                                         | No                | No                    |
| **Data Display**                                   |                                                                                                                                |                   |                       |
| Data table (sort, filter, paginate)                | Yes                                                                                                                            | Yes (basic)       | Yes (basic)           |
| Stat cards with trends                             | Yes (StatCard + TrendIndicator)                                                                                                | No                | No                    |
| **Interactive pivot tables**                       | **Yes (new — sort, drill-through, drill-down, cross-filter, aggregator switcher, heatmap mode, multi-value/multi-aggregator)** | No                | No                    |
| **Layout**                                         |                                                                                                                                |                   |                       |
| Multi-widget dashboard layout                      | Yes (LayoutGrid, LayoutRow, LayoutColumn)                                                                                      | No (chat thread)  | Basic (pinned charts) |
| Interactive controls (filters, what-if)            | Yes (SelectControl, NumberInput, DataController)                                                                               | No                | No                    |
| Cross-chart filtering                              | Yes (sub-second client-side)                                                                                                   | No                | No                    |
| Drill-down (click → re-analyze)                    | Yes                                                                                                                            | No                | No                    |

**Hermetic wins overwhelmingly on visualization, and the lead has widened** — the native chart library grew from 35+ to **57 AI-selected types** (added Pareto, QQ, ECDF, Kaplan–Meier survival, forest, control/SPC, correlogram, error bars/CI, calibration, lift/gain, partial dependence, dendrogram, silhouette, network graph, dual-axis, funnel, gauge, bullet, waterfall, marimekko, contour, ternary, population pyramid, Gantt, cohort grid, quiver, wind rose, Scatter3D, Surface3D, Globe3D, and deck.gl maps) vs ~10 for Julius and ~8 for Vizly. Interactive pivot tables are also new. More importantly, Hermetic composes them into coherent multi-widget dashboards; Julius and Vizly produce one chart at a time in a chat thread.

---

## Interactive Features

| Feature                      | Hermetic                                                                                                                           | Julius AI                | Vizly             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------- |
| Dashboard layout             | AI-generated (grid, columns)                                                                                                       | No (chat thread)         | Basic (pin board) |
| Drill-down                   | Yes (click to re-analyze with filtered context)                                                                                    | No                       | No                |
| Cross-filtering              | Yes (DataController)                                                                                                               | No                       | No                |
| **Interactive pivot tables** | **Yes (new — drill-through, cross-filter, aggregator switcher, heatmap mode)**                                                     | No                       | No                |
| Dynamic inputs               | Yes (SelectControl, NumberInput, ToggleSwitch, TextInput, TextArea)                                                                | No                       | No                |
| What-if analysis             | Yes (reactive state, compute pipelines)                                                                                            | Limited (via code edits) | No                |
| Hover tooltips               | Yes (Plotly, Nivo, deck.gl)                                                                                                        | Yes (Plotly)             | Yes (Plotly)      |
| Chart zoom/pan               | Yes                                                                                                                                | Yes                      | Yes               |
| Chart fullscreen             | Yes (every chart, dynamic legend repositioning)                                                                                    | Yes                      | Yes               |
| **Scheduled dashboard runs** | **Yes (new — node-cron scheduler, schedule popover on the toolbar, schedule pills on saved-viz cards, edit/delete in place)**      | No                       | No                |
| Persistent history           | **Yes (new — auto-saves every analysis to disk; survives restarts; dedicated history page; restore or re-run against fresh data)** | Chat thread persistence  | Pinned charts     |

**Hermetic wins on interactivity, and now adds scheduling and durable history.** Julius and Vizly are largely static chat outputs. Hermetic now also refreshes a saved dashboard on a cron schedule and keeps every past analysis (code, results, visualizations) on disk across restarts — though scheduled runs remain local-only, with no email/Slack distribution.

---

## Statistical / ML Features

| Feature                                              | Hermetic                                                                                                                                         | Julius AI                    | Vizly   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------- |
| Regression / hypothesis tests                        | Yes (via generated Python)                                                                                                                       | Yes (first-class capability) | Basic   |
| Forecasting / time series                            | Yes (via Python/sandbox; statsmodels available)                                                                                                  | Yes                          | Limited |
| Anomaly / outlier detection                          | Yes (via Python; plus auto-detected in schema)                                                                                                   | Yes                          | No      |
| Statistical schema metadata                          | Yes (skewness, kurtosis, percentiles, correlations, distribution shape)                                                                          | Limited                      | Limited |
| **Native statistical chart types**                   | **Yes (new — Pareto, QQ, ECDF, Kaplan–Meier survival, forest, control/SPC, calibration, lift/gain, partial dependence, silhouette, dendrogram)** | Via code                     | No      |
| ML chart types (ROC, confusion, SHAP, decision tree) | Yes (native)                                                                                                                                     | Via code                     | No      |
| Auto-generated insights                              | Yes (data-domain detection: financial, time-series, statistical)                                                                                 | Limited                      | No      |

**Hermetic's statistical lead widens.** Both Hermetic and Julius can do meaningful statistical work; Julius leans into the _interactive statistical workflow_ (edit code, re-run, ask follow-ups), and Hermetic now matches the iteration loop with edit-and-rerun while also surfacing a much broader set of statistical charts natively (survival curves, control charts, calibration, lift/gain, partial dependence) plus rich schema metadata fed into the LLM.

---

## Export

| Feature                                        | Hermetic                                                              | Julius AI           | Vizly |
| ---------------------------------------------- | --------------------------------------------------------------------- | ------------------- | ----- |
| PDF                                            | Yes (themed, multi-page A4)                                           | Yes (Pro)           | No    |
| DOCX                                           | Yes (landscape)                                                       | No                  | No    |
| PPTX                                           | Yes (single slide)                                                    | No                  | No    |
| **Slides**                                     | **Yes (new — export format; Investigate Notebook exports to Slides)** | No                  | No    |
| PNG                                            | Yes (2× pixel ratio)                                                  | Yes                 | Yes   |
| CSV                                            | Yes                                                                   | Yes                 | Yes   |
| XLSX (multi-sheet, styled)                     | Yes                                                                   | No                  | No    |
| **Notebook export (MD / HTML / PDF / Slides)** | **Yes (new — Investigate Notebook mode)**                             | No                  | No    |
| Code download                                  | Yes (Python script)                                                   | Yes (copy/download) | No    |
| Share link                                     | No                                                                    | Yes                 | No    |
| Embed                                          | No                                                                    | Limited             | No    |

**Hermetic wins on export** — professional document formats (DOCX, PPTX, multi-sheet styled XLSX) that Julius and Vizly lack entirely, now joined by Investigate Notebook export to Markdown / HTML / PDF / Slides. Julius still wins on share links.

---

## Privacy & Deployment

| Feature                             | Hermetic                                                                              | Julius AI                                     | Vizly                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------- |
| Self-hosted                         | Yes                                                                                   | No                                            | No                     |
| Fully offline                       | Yes (Docker + local LLM)                                                              | No                                            | No                     |
| Data stays local                    | Yes (always)                                                                          | No (uploaded to cloud)                        | No (uploaded to cloud) |
| LLM never sees row data             | **Yes (schema-only context, planner included)**                                       | No (data flows through AI for code execution) | No                     |
| **Transparent local cost tracking** | **Yes (new — per-analysis token + USD ledger on your own disk, no per-seat billing)** | No (cloud per-seat / credit billing)          | No                     |
| Open source                         | Yes (MIT)                                                                             | No                                            | No                     |
| SOC 2                               | N/A (self-hosted)                                                                     | Claimed                                       | Unknown                |
| SSO / SAML                          | No                                                                                    | Enterprise tier                               | Unknown                |
| Audit logs / RBAC                   | No                                                                                    | Enterprise tier                               | Unknown                |
| Data retention                      | Permanent (your disk)                                                                 | Plan-dependent (Plus 7 days, Pro extended)    | Unknown                |
| Data used for training              | No                                                                                    | Per policy: not used                          | Unknown                |

**Hermetic wins decisively on privacy.** Data never leaves your machine, and the LLM — including the Investigate planner — operates on schema and statistics, never on row values. Julius and Vizly upload data to their cloud servers and pass it through their AI infrastructure. New in this version: cost is fully transparent and local — a per-analysis token + USD ledger on your own disk, instead of opaque per-seat or credit billing.

---

## Pricing Comparison (April 2026 baseline)

|                                   | Hermetic          | Julius Free | Julius Plus (Bloom $19.90+ / Chat $3.90+) | Julius Pro (~$45/mo)                                        | Julius Business / Enterprise | Vizly Free | Vizly Paid             |
| --------------------------------- | ----------------- | ----------- | ----------------------------------------- | ----------------------------------------------------------- | ---------------------------- | ---------- | ---------------------- |
| **Price**                         | Free              | $0          | from $3.90–$19.90/mo                      | ~$45/mo (~$37 ann.)                                         | Custom                       | $0         | Public pricing limited |
| Messages/mo                       | Unlimited         | 15          | Plan-dependent                            | Unlimited                                                   | Unlimited                    | ~10        | More                   |
| File size                         | 100MB             | ~50MB       | Larger                                    | Larger                                                      | Custom                       | Small      | Larger                 |
| Live database connectors          | 7                 | 0           | 0                                         | 6+ (PG, Snowflake, BigQuery, MySQL, SQL Server, Databricks) | + SSO, RBAC, audit           | 0          | 0                      |
| Custom Agents / agentic workflows | Yes (Investigate) | No          | Plus (Bloom)                              | Yes                                                         | Yes                          | No         | No                     |
| Chart types                       | 57                | ~10         | ~10                                       | ~12                                                         | ~12                          | ~8         | ~8                     |
| Dashboard layout                  | Yes (AI)          | No          | No                                        | No                                                          | No                           | Basic      | Basic                  |
| Per-analysis cost tracking        | Yes               | No          | No                                        | No                                                          | No                           | No         | No                     |
| Offline mode                      | Yes               | No          | No                                        | No                                                          | No                           | No         | No                     |
| Self-hosted                       | Yes               | No          | No                                        | No                                                          | No                           | No         | No                     |
| BYO LLM                           | Yes (7)           | No          | No                                        | No                                                          | Limited                      | No         | No                     |

15% off annual on Julius. 50% off all Julius plans for students/educators. _(Julius/Vizly pricing carried forward from the 2026-04-25 baseline.)_

---

## Also in This Category

Other tools competing in the "upload data, ask question, get chart" space:

| Tool                         | Key Difference from Hermetic                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| **ChatGPT Code Interpreter** | Massive distribution, but no persistent dashboards, session-based, no warehouse connectors  |
| **Claude Analysis tool**     | Built into Claude.ai; in-browser sandbox; no warehouse/file connectors; no persistent state |
| **Gemini Data Analyst**      | In Google Sheets / Workspace; tied to Google data sources                                   |
| **Powerdrill AI**            | "Bloom"-style autonomous agents, Chat plan from $3.90/mo, file-upload focus                 |
| **Querio AI**                | NL-to-SQL with conversational analysis, AI-native notebook                                  |
| **Akkio**                    | Targets agencies with white-labeling, ML prediction focus, ~$49/mo                          |
| **Polymer Search**           | Auto-generates dashboards from spreadsheets, no-code, ~$10/mo, no AI question answering     |
| **Obviously AI**             | ML prediction focus, not ad-hoc visualization, ~$75/mo                                      |

---

## What's New Since the Previous Version

**On the Hermetic side (since 2026-04-25):**

_Wave 1 (Apr 25 → May 31):_

- **Snowflake connector** — inline + saved connection forms, dialect-aware SQL prompts, per-warehouse tab and color code in the UI. Closes the biggest warehouse gap vs. Julius.
- **Databricks connector** — SQL warehouse + personal access token auth, dialect-aware SQL. Hermetic now supports 7 warehouses total (PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, Hive).
- **Investigate agent** — multi-step analysis. Planner decomposes a question into 3–7 sub-questions, orchestrator runs independents in parallel waves and dependents serially, composer synthesizes one unified dashboard. Privacy posture unchanged (planner sees schema + stats only, never row values).
- **Scheduled dashboard runs** — node-cron under the hood, schedule popover anchored to the dashboard toolbar, schedule pills on saved-viz cards with edit/delete in place.
- **Persistent analysis history** — every analysis auto-saves to disk (generated code, results, visualizations), survives restarts, with a dedicated history page and one-click restore or re-run against fresh data.
- **Edit-and-rerun** on the generated Python or SQL — edit in the code editor, server skips the generation step for that artifact and re-runs everything downstream.
- **Interactive pivot tables** — sort, drill-through, drill-down, cross-filter with other widgets, aggregator switcher, heatmap mode, multi-value / multi-aggregator support.
- **Multi-retry with reflection** — up to 3 retries on failed code execution; after 2 failures the model gets the full failed-attempt history plus a reflection prompt.
- **Suggested follow-up questions** — inline pills after each analysis suggest the next obvious question.
- **dbt metadata enrichment** — column-level descriptions pulled into the LLM context alongside the warehouse schema.

_Wave 2 (May 31 → Jun 20):_

- **Per-analysis LLM cost tracking** — usage-reporting middleware captures the whole fan-out (code-gen, retries, planner, sub-questions, compose) with zero call-site threading. Surfaced as (a) a live footer (last analysis + session total), (b) a per-day CSV log `data/cost/<YYYY-MM-DD>.csv` with token buckets + cost_usd per analysis, and (c) a `/cost` page + `GET /api/cost` with totals and a per-dataset breakdown. Local/unknown models report $0 but still track tokens — a fully-local, transparent alternative to opaque per-seat / credit billing.
- **LLM cost optimization** — Anthropic ephemeral prompt caching (~90% input discount on cache hits) on large static prompts, cheaper models (Sonnet heavy / Haiku classifier), fewer retries, and lazy cell composition.
- **Chart library expanded from 32 to 57 native AI-selected types** — added Pareto, QQ, ECDF, Kaplan–Meier survival, forest, control/SPC, correlogram, error bars/CI, calibration, lift/gain, partial dependence, dendrogram, silhouette, network graph, dual-axis, funnel, gauge, bullet, waterfall, marimekko, contour, ternary, population pyramid, Gantt, cohort grid, quiver, wind rose, Scatter3D, Surface3D, Globe3D, and deck.gl maps.
- **Investigate Notebook mode** — a cell-based notebook view of the investigation, exportable to Markdown / HTML / PDF / Slides.
- **Output styles consolidated to 4** — Dashboard, Brief, Report, Deep dive (Slides is now an export format rather than a style).
- **Onboarding / landing redesign** — privacy-forward hero ("the model writes the code — it never sees your rows"), a payoff preview of real generated dashboards before upload, real drag-and-drop upload, a prominent one-click sample dataset, and a trust strip.
- **Reliability fix** — generated code no longer crashes on hard-coded value assertions emitted by local models.

**On the Julius / Vizly side:** specific feature claims and pricing in this doc are carried forward from the 2026-04-25 baseline. Consult the Julius and Vizly changelogs for net-new features since then.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **complete multi-widget dashboards** from a single question, with no cell-by-cell follow-ups
- You want a **multi-step deep-dive** ("why did X spike?") without orchestrating it yourself — **Investigate** does the decomposition
- **Data privacy matters** (regulated industries, sensitive data, air-gapped environments)
- You want the **LLM to never see your data** (schema + statistics only, planner included)
- You need **57 chart types** including maps, 3D, ML-specific, financial, survival/control/calibration, and **interactive pivot tables**
- You want **warehouse connectivity** (PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, Hive) without subscribing to a cloud SaaS
- You need **document exports** (PDF, DOCX, PPTX, multi-sheet XLSX, plus Notebook export to MD/HTML/PDF/Slides)
- You want **transparent, local cost tracking** (per-analysis token + USD ledger) instead of opaque per-seat billing
- You want to **choose your LLM** or run models locally (Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)
- You want **zero cost** with no message limits
- You need **scheduled dashboard refreshes** but don't need email/Slack distribution
- You need **Parquet / DuckDB for big-local data** without uploading

### Choose Julius AI when:

- You want a **conversational, agentic data exploration** experience with autonomous Bloom agents
- You want to **edit generated code inline** and iterate
- You're a **researcher or analyst** doing exploratory or statistical analysis (regression, forecasting, hypothesis tests are first-class)
- You want **live warehouse connections** (Snowflake, Databricks, BigQuery, Postgres, MySQL, SQL Server, Supabase) with auto-built semantic layers
- You need **SaaS connectors** (Google Drive, OneDrive, Google Ads, Stripe)
- You're comfortable with **cloud data processing** and want share links + collaboration
- You want **Custom Agents** to encode repeatable analytical workflows

### Choose Vizly when:

- You want the **simplest possible** upload-and-ask experience
- You need to **extract tables from PDFs or analyze SPSS files**
- You want to quickly **pin charts into a simple board**
- You're an **academic researcher** with SPSS data and prefer a lighter UI than Julius

### The Fundamental Difference

**Hermetic** produces a **complete, interactive dashboard** — stat cards, charts, tables, narrative text, filters, drill-downs — all composed and laid out by AI from a single question, with **the LLM never seeing your data**. For complex questions, **Investigate** decomposes them into sub-steps without you having to, and every analysis carries a transparent, local cost ledger.

**Julius and Vizly** produce **one chart per message** in a chat thread, sending your data to the cloud. Julius adds agentic workflows on top (Bloom autonomous agents, Custom Agents) for iterative analysis. Vizly is the simpler conversational counterpart with niche format support.

Hermetic replaces the workflow. Julius and Vizly assist within it.

# Hermetic vs Hex.tech — Competitive Feature Comparison

_Last updated: 2026-04-25_

## Overview

| Category        | Hermetic                                                       | Hex.tech                                                                |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Core Model**  | AI-first: ask a question, get a complete dashboard             | AI Analytics Platform: notebooks + Notebook Agent + apps for whole team |
| **Deployment**  | Self-hosted / local-first                                      | Cloud SaaS only (single-tenant Enterprise option)                       |
| **Pricing**     | Open source (free)                                             | Free → $36/editor/mo (Pro) → $75/editor/mo (Team) → custom (Enterprise) |
| **Target User** | Analyst who wants answers fast, no code, data stays local      | Cross-functional data team: analysts, engineers, business users         |
| **AI Posture**  | LLM never sees the data — schema-only context, blind execution | Notebook Agent has full schema + project context, generates code        |

---

## Data Sources

| Feature                                       | Hermetic                                      | Hex                                                 |
| --------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| CSV upload                                    | Yes (100MB)                                   | Yes                                                 |
| Excel (multi-sheet + relationship detection)  | Yes (auto-detects cross-sheet FKs)            | Yes (basic upload)                                  |
| GeoJSON / JSON native                         | Yes (auto geometry detection)                 | JSON yes; GeoJSON via Python                        |
| Parquet files (single + Hive-partitioned)     | **Yes (DuckDB-backed, zero-copy bind-mount)** | Yes                                                 |
| Local file browser                            | **Yes (browse host filesystem from sandbox)** | No                                                  |
| PostgreSQL / Redshift / Neon / Supabase       | Yes (PG-wire compatible)                      | Yes                                                 |
| BigQuery (incl. BigQuery DataFrames)          | Yes                                           | Yes (native + BigFrames pushdown)                   |
| Snowflake (incl. Snowpark)                    | No                                            | Yes (native + Snowpark pushdown)                    |
| Databricks (incl. Unity Catalog Metric Views) | No                                            | Yes (added Oct 2025)                                |
| ClickHouse                                    | Yes                                           | Yes                                                 |
| Trino / Starburst                             | Yes                                           | Yes                                                 |
| Hive                                          | Yes                                           | Via Trino                                           |
| MotherDuck / DuckDB                           | DuckDB in-sandbox                             | Yes                                                 |
| MySQL / SQL Server / Oracle                   | No                                            | Yes                                                 |
| Athena / AlloyDB                              | No                                            | Yes                                                 |
| dbt Core / dbt Cloud / MetricFlow             | No                                            | Yes (deep — schema enrichment, semantic-layer cell) |
| dbt / Cube / Snowflake Semantic Views         | No                                            | Yes (semantic-model awareness across all four)      |
| API / HTTP sources                            | No                                            | Via Python                                          |
| OAuth-per-user data connections               | No                                            | Yes (Snowflake, Databricks, BigQuery)               |
| SSH tunneling                                 | No                                            | Yes (added 2025 for Databricks/Postgres)            |

**Hex wins on warehouse breadth** — 15+ native connectors plus deep dbt and semantic-layer integration. **Hermetic wins on file-format intelligence and zero-copy ingestion** — Parquet folders (including Hive-partitioned datasets) are bind-mounted read-only into the sandbox so terabyte-scale local data never copies.

---

## AI / LLM Capabilities

| Feature                            | Hermetic                                                                          | Hex (Magic + Notebook Agent)                                     |
| ---------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| NL to complete dashboard           | Yes (one prompt → multi-widget JSON-Render spec)                                  | Partial (Notebook Agent builds full notebooks/apps step-by-step) |
| NL to SQL                          | Yes (dialect-aware, cross-table JOINs)                                            | Yes (Magic SQL, semantic-layer aware)                            |
| NL to Python                       | Yes (generates + executes blind)                                                  | Yes (Magic Python in notebook cells)                             |
| NL to R                            | No                                                                                | Yes                                                              |
| NL to chart                        | Yes (auto-selects from 35+ types)                                                 | Yes (Magic Chart, plus Notebook Agent chart-cell generation)     |
| Inline code completion (typeahead) | No                                                                                | Yes (context-aware, schema-aware)                                |
| Code explain / debug / edit        | No                                                                                | Yes (Magic Explain, Magic Debug, Magic Edit)                     |
| Agentic notebook construction      | No (single-shot dashboard)                                                        | Yes (Notebook Agent — autonomous multi-cell workflow)            |
| Multi-provider LLM                 | Yes (7: Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)        | No (Hex chooses provider; some BYO LLM available on Enterprise)  |
| Local / offline LLM                | Yes (MLX, llama.cpp, Ollama with curated 8/16/24/48GB tiers)                      | No                                                               |
| Schema-aware code-gen              | Yes (column types, distributions, correlations, FK relationships)                 | Yes (warehouse schema, dbt docs, project execution graph)        |
| Output style control               | Yes (6: Infographic, Narrative, Executive Summary, Deep Analysis, Slides, Report) | No (single notebook/app format)                                  |
| Drill-down re-analysis             | Yes (click chart segment → new AI analysis with filtered context)                 | Manual re-query via Magic                                        |
| Follow-up / conversation context   | Yes (server-side conversation cache, 5 turns)                                     | Yes (Threads, Magic context within project)                      |
| Suggested questions / explorations | Yes (LLM-generated from schema on file load)                                      | Yes (suggested explorations)                                     |
| Methodology disclosure             | Yes (plain-English summary of rows, columns, ops on every analysis)               | Visible in cell outputs / generated code                         |
| Schema-only privacy mode           | **Yes — LLM never sees data values, only schema + statistics**                    | No (data flows through Hex's AI infra)                           |
| Verifiable outputs (audit trail)   | Yes (artifacts panel: SQL + Python + computed tables, downloadable)               | Yes (every AI action visible as cells + version history)         |

**Hermetic wins on AI autonomy and privacy** — one question produces a styled, multi-component dashboard, and the LLM never sees raw data values. **Hex wins on agentic notebook construction** — the Notebook Agent (GA 2025) plus Magic Edit/Debug/Explain handle iterative analytical workflows that span many cells, with R support for statistical workflows.

---

## Visualization

| Feature                                             | Hermetic                                       | Hex                                          |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| Native chart types                                  | 35+ (AI-selected from JSON spec)               | ~14 built-in chart-cell types                |
| No-code chart creation                              | AI-driven (fully automatic)                    | Drag-and-drop chart builder + Magic Chart    |
| Code-based charts                                   | Sandbox Python (matplotlib, plotly, seaborn)   | Full Python/R environment (any library)      |
| **Basic Charts**                                    |                                                |                                              |
| Bar (grouped, stacked, horizontal)                  | Yes                                            | Yes                                          |
| Line (multi-series, stepped)                        | Yes                                            | Yes                                          |
| Area (stacked, overlaid)                            | Yes                                            | Yes                                          |
| Pie / Donut                                         | Yes                                            | Yes                                          |
| Scatter (with regression)                           | Yes                                            | Yes                                          |
| Histogram                                           | Yes                                            | Yes                                          |
| **Distribution**                                    |                                                |                                              |
| Box Plot                                            | Yes                                            | Yes                                          |
| Violin                                              | Yes                                            | Via Python                                   |
| Ridgeline (joy plots)                               | Yes                                            | Via Python                                   |
| Beeswarm                                            | Yes                                            | Via Python                                   |
| **Hierarchical**                                    |                                                |                                              |
| Treemap                                             | Yes                                            | Yes                                          |
| Sunburst                                            | Yes                                            | Via Python                                   |
| **Network & Flow**                                  |                                                |                                              |
| Sankey                                              | Yes (native)                                   | Via Python                                   |
| Chord diagram                                       | Yes (native)                                   | Via Python                                   |
| Stream chart                                        | Yes (native)                                   | Via Python                                   |
| **Comparison & Ranking**                            |                                                |                                              |
| Bump chart                                          | Yes                                            | Via Python                                   |
| Dumbbell / Slope                                    | Yes                                            | Via Python                                   |
| Bullet chart                                        | Yes                                            | Via Python                                   |
| Waterfall                                           | Yes                                            | Via Python                                   |
| Marimekko                                           | Yes                                            | Via Python                                   |
| Radar / Spider                                      | Yes                                            | Via Python                                   |
| **ML / Statistical**                                |                                                |                                              |
| Confusion matrix                                    | Yes (native)                                   | Via Python                                   |
| ROC / PR curve                                      | Yes (native)                                   | Via Python                                   |
| SHAP beeswarm                                       | Yes (native)                                   | Via Python                                   |
| Decision tree                                       | Yes (native)                                   | Via Python                                   |
| Parallel coordinates                                | Yes                                            | Via Python                                   |
| **Financial**                                       |                                                |                                              |
| Candlestick (OHLC)                                  | Yes (native)                                   | Via Python                                   |
| **Geographic**                                      |                                                |                                              |
| 2D Map (markers + choropleth)                       | Yes (MapLibre GL)                              | Via Folium / Plotly / Python                 |
| 3D Globe (arcs + points, with arc filtering)        | Yes (react-globe.gl)                           | No                                           |
| 3D Deck.gl (hexagon, column, arc, heatmap, scatter) | Yes (5 layer types, click/hover interactivity) | No                                           |
| **3D Plots**                                        |                                                |                                              |
| Scatter3D / Surface3D                               | Yes (Plotly 3D)                                | Via Python                                   |
| **Calendar**                                        |                                                |                                              |
| Calendar heatmap                                    | Yes (GitHub-style)                             | Via Python                                   |
| **Data Display**                                    |                                                |                                              |
| Data table (sort, filter, paginate)                 | Yes                                            | Yes (with sparklines)                        |
| Stat cards / KPI                                    | Yes (StatCard + TrendIndicator + format hints) | Yes (Single value / Big Number cell)         |
| Pivot tables                                        | No (DataTable only)                            | Yes (Pivot cell — Notebook Agent can author) |
| Conditional formatting                              | Tables only                                    | Yes                                          |

**Hermetic wins on out-of-the-box chart diversity** — 35+ native types AI-selected with no code, including specialized analytical charts (Sankey, SHAP, ROC, candlestick, deck.gl 3D maps) that Hex requires Python for. **Hex wins on unlimited customization and pivot tables** — any Python or R library, any chart, fully programmable.

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

**Hex wins on app-building maturity** — App Builder is a flagship product with custom theming, conditional visibility, button triggers, and Components. **Hermetic wins on zero-effort composition** — AI generates the entire interactive layout from one question.

---

## Collaboration & Sharing

| Feature                       | Hermetic               | Hex                                                |
| ----------------------------- | ---------------------- | -------------------------------------------------- |
| Real-time multiplayer editing | No                     | Yes (Google Docs-style)                            |
| Comments / threads            | No                     | Yes (Threads on cells, also AI-aware)              |
| Version history               | Yes (per-viz versions) | Yes (full, with restore/fork)                      |
| Git integration               | No                     | Yes (GitHub, GitLab; Enterprise)                   |
| Role-based access (RBAC)      | No                     | Yes (Admin, Editor, Viewer, Publisher, App user)   |
| Workspace organization        | No                     | Yes (Collections, status workflows)                |
| Published apps                | No                     | Yes (standalone web apps, dashboards)              |
| Scheduled runs (cron)         | No                     | Yes (with email/Slack delivery)                    |
| Embed in other tools          | No                     | Yes (signed embedding, custom theming, headerless) |
| API-triggered runs            | No                     | Yes (REST API)                                     |
| Review workflows              | No                     | Yes (Draft / In Review / Published statuses)       |
| Shared data connections       | No (per-user)          | Yes (workspace-level + OAuth per-user)             |
| Semantic layer awareness      | No                     | Yes (dbt MetricFlow, Cube, Snowflake, Databricks)  |

**Hex wins decisively on collaboration.** Hermetic is a single-user, local-first tool by design — privacy and control are the tradeoff.

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
| Code download (Python)       | Yes                             | Yes (Git export) |
| Shareable links              | No                              | Yes              |
| Scheduled email reports      | No                              | Yes              |
| Slack integration            | No                              | Yes              |
| Notion / Confluence embed    | No                              | Yes              |
| Signed embed (no Hex chrome) | No                              | Yes              |

**Hermetic wins on document export** — DOCX, PPTX, multi-sheet styled XLSX are unique. **Hex wins on automated distribution** — scheduled emails, Slack, signed embeds, custom-themed apps.

---

## Code & Transparency

| Feature                   | Hermetic                                      | Hex                                    |
| ------------------------- | --------------------------------------------- | -------------------------------------- |
| View generated SQL        | Yes (Artifacts panel, syntax-highlighted)     | N/A (user / agent writes SQL)          |
| View generated Python     | Yes (full code, downloadable)                 | N/A (user / agent writes Python)       |
| View computed data tables | Yes (Artifacts panel, exportable as CSV/XLSX) | Yes (cell outputs)                     |
| Notebook IDE              | No (AI-generated only)                        | Yes (full notebook with cells)         |
| SQL cells                 | No (AI generates SQL, no editor)              | Yes (first-class)                      |
| Python cells              | No (AI generates Python, no editor)           | Yes (full environment)                 |
| R support                 | No                                            | Yes                                    |
| Custom pip packages       | Sandbox-constrained                           | pip install anything (Team/Enterprise) |
| Reusable logic            | No                                            | Yes (Components, Magic templates)      |
| dbt-aware code-gen        | No                                            | Yes (dbt docs enrich schema context)   |
| Inline typeahead          | No                                            | Yes (context-aware completions)        |

**Hex wins on code flexibility** — full IDE, R support, dbt-aware autocomplete, package install. **Hermetic wins on transparency** — surfaces exactly what the AI generated (SQL + Python + computed tables) so you can verify, export, or version it without learning a notebook.

---

## Privacy & Deployment

| Feature                    | Hermetic                            | Hex                                                 |
| -------------------------- | ----------------------------------- | --------------------------------------------------- |
| Self-hosted                | Yes                                 | No (single-tenant Enterprise hosting only)          |
| Fully offline / air-gapped | Yes (Docker + local LLM)            | No                                                  |
| Data stays on-premise      | Yes (always)                        | No (SQL runs on your warehouse, Python runs on Hex) |
| LLM never sees row data    | **Yes (schema + stats only)**       | No (data flows through AI for code-gen + execution) |
| Open source                | Yes (MIT)                           | No (proprietary)                                    |
| No vendor lock-in          | Yes (standard formats, JSON-Render) | No (proprietary notebook format)                    |
| BYO LLM                    | Yes (any of 7 providers + local)    | Limited (Enterprise only)                           |
| SOC 2 compliance           | N/A (self-hosted)                   | Yes (Type II, Team / Enterprise)                    |
| SSO / SAML                 | No                                  | Enterprise tier                                     |
| Audit logs                 | No                                  | Enterprise tier                                     |
| VPC / Private Link         | No                                  | Enterprise tier                                     |
| GDPR / HIPAA               | N/A (self-hosted)                   | GDPR yes; HIPAA Enterprise                          |

**Hermetic wins on privacy and control.** Data never leaves your machine. The LLM operates on schema and statistics — never on row values. **Hex wins on enterprise compliance** for organizations that need a managed cloud platform.

---

## Pricing Comparison (April 2026)

|                            | Hermetic      | Hex Community | Hex Professional   | Hex Team               | Hex Enterprise |
| -------------------------- | ------------- | ------------- | ------------------ | ---------------------- | -------------- |
| **Price**                  | Free (OSS)    | $0            | ~$36/editor/mo     | ~$75/editor/mo         | Custom         |
| Editors                    | Unlimited     | 1             | Individual / small | Full teams             | Org-wide       |
| Compute                    | Your hardware | Limited       | Medium included    | Medium + pay-as-you-go | Custom         |
| Notebook Agent             | N/A           | Limited       | Yes                | Yes                    | Yes            |
| Scheduled runs             | N/A           | No            | Yes                | Yes                    | Yes            |
| SSO                        | N/A           | No            | No                 | No                     | Yes            |
| Published apps             | N/A           | Limited       | Yes                | Yes                    | Yes            |
| dbt / semantic-layer cells | N/A           | Yes           | Yes                | Yes                    | Yes            |
| BYO LLM                    | Yes           | No            | No                 | No                     | Limited        |

Free for students/educators at universities and qualifying non-profits.

**Hermetic's cost advantage:** A team of 10 editors on Hex Team is ~$750/month or $9,000/year. Hermetic costs $0 plus your own compute. The tradeoff is self-hosting responsibility and no collaboration features.

---

## What's New Since the Previous Version of This Comparison

**On the Hermetic side (since March 2026):**

- **Parquet & DuckDB support** — single Parquet files and Hive-partitioned datasets are detected in the file browser; DuckDB is always available in the sandbox alongside pandas, with full statistical schema extraction (percentiles, correlations, distributions) computed via DuckDB SQL.
- **Local file browser with bind-mount** — browse the host filesystem, read-only mount any data file or folder into the sandbox without a copy. Eliminates the upload bottleneck for large local data.
- **Persistent analysis history** — every analysis auto-saved with replay/restore/delete. History page with expandable entries; Restore button rehydrates a saved viz without re-running the LLM.
- **Server-side conversation cache** — follow-up questions reference prior turn summaries (5 turns, 30-min TTL) so the LLM doesn't have to re-process the full spec.
- **Globe arc filtering** — origin-destination flow visualization on the 3D globe, with arc-level filtering.
- **Increased local sandbox timeout** — extended from 120s to 300s to accommodate large Parquet datasets.
- **Saved warehouse connections as one-click pills** on the home screen; managed in Settings.

**On the Hex side (since March 2026):**

- **Notebook Agent GA + ongoing updates** — agentic creation/modification of Python, SQL, Markdown, Pivot, and Chart cells, with chart styling and input parameters. Typeahead inline completions are context-aware.
- **Threads** — conversational analytics surface for business users on top of validated semantic models.
- **Semantic Model Agent** — generates and maintains semantic-layer definitions.
- **Databricks Unity Catalog Metric Views integration** — joins existing dbt MetricFlow, Cube, and Snowflake Semantic Views support.
- **SSH tunneling** for Databricks/Postgres connections behind firewalls.
- **OAuth per-user data connections** for Snowflake / Databricks / BigQuery — each user authenticates with their own warehouse identity, enabling row-level security at source.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **question to dashboard in seconds** with zero coding
- **Data privacy is non-negotiable** (air-gapped, on-prem, regulated industries)
- You want the **LLM to never see your data** (schema-only context)
- You need **35+ chart types selected automatically** by AI, including specialized ones (Sankey, SHAP, ROC, deck.gl 3D maps, candlesticks)
- You want **rich document exports** (PowerPoint, Word, multi-sheet styled Excel)
- You want to **bring your own LLM** or run models locally (Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)
- You need **Parquet / DuckDB for big-local data** without uploading
- You're a **solo analyst or small team** without collaboration needs
- You want **zero vendor lock-in** and full control

### Choose Hex when:

- You need a **collaborative analytics platform for a data team** with multiplayer editing, threads, version history
- You want to **build, version, and publish interactive web apps** with custom theming and signed embeds
- You need **15+ native warehouse connectors**, especially Snowflake/Databricks/Redshift with OAuth per-user
- You want a **full Python/R/SQL IDE** with Magic, Notebook Agent, and inline typeahead
- You need **deep dbt and semantic-layer integration** (MetricFlow, Cube, Snowflake Semantic Views, Databricks Metric Views)
- You need **scheduled reports, embedding, and stakeholder distribution**
- You want **agentic notebook construction** that can iterate across many cells
- You need **enterprise compliance** (SOC 2, SSO, audit logs, VPC, HIPAA on Enterprise)

### The Fundamental Difference

**Hermetic** is an **AI-first, single-shot dashboard generator**. One question produces a complete, styled, multi-component interactive dashboard in one streaming response — and the LLM never sees a single row of your data. It replaces the analyst workflow for routine questions.

**Hex** is an **AI-augmented notebook + app platform** that pairs a full SQL/Python/R IDE with the Notebook Agent and Magic features. The AI is a powerful collaborator inside a code-first environment built for teams.

They serve different workflows. Hermetic is for "give me the answer." Hex is for "help me find — and ship — the answer with my team."

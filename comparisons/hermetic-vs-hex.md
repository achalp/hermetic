# Hermetic vs Hex.tech — Competitive Feature Comparison

_Last updated: 2026-03-24_

## Overview

| Category        | Hermetic                                           | Hex.tech                                        |
| --------------- | -------------------------------------------------- | ----------------------------------------------- |
| **Core Model**  | AI-first: ask a question, get a complete dashboard | Notebook-first: write code cells, build apps    |
| **Deployment**  | Self-hosted / local-first                          | Cloud SaaS only                                 |
| **Pricing**     | Open source (free)                                 | $0–$75+/user/month + compute overage            |
| **Target User** | Analyst who wants answers fast, no code            | Analyst/engineer who wants a coding environment |

---

## Data Sources

| Feature                                      | Hermetic                           | Hex                    |
| -------------------------------------------- | ---------------------------------- | ---------------------- |
| CSV upload                                   | 100MB limit                        | Yes                    |
| Excel (multi-sheet + relationship detection) | Yes (auto-detects cross-sheet FKs) | Yes (basic upload)     |
| GeoJSON native                               | Yes (auto geometry detection)      | No (manual via Python) |
| PostgreSQL                                   | Yes                                | Yes                    |
| BigQuery                                     | Yes                                | Yes                    |
| ClickHouse                                   | Yes                                | Yes                    |
| Trino                                        | Yes                                | Yes                    |
| Hive                                         | Yes                                | Via Trino              |
| Snowflake                                    | No                                 | Yes                    |
| Databricks                                   | No                                 | Yes                    |
| Redshift                                     | No                                 | Yes                    |
| MySQL / SQL Server                           | No                                 | Yes                    |
| DuckDB                                       | No                                 | Yes (embedded)         |
| Motherduck / AlloyDB                         | No                                 | Yes                    |
| Amazon Athena                                | No                                 | Yes                    |
| dbt integration                              | No                                 | Yes                    |
| API/HTTP sources                             | No                                 | Yes (via Python)       |
| Parquet files                                | No                                 | Yes                    |

**Hex wins on warehouse breadth** (13+ connectors vs 5). **Hermetic wins on file format intelligence** (auto-relationship detection across Excel sheets, native GeoJSON support).

---

## AI / LLM Capabilities

| Feature                  | Hermetic                                                                                     | Hex                       |
| ------------------------ | -------------------------------------------------------------------------------------------- | ------------------------- |
| NL to complete dashboard | Yes (one prompt, full viz)                                                                   | No (cell-by-cell)         |
| NL to SQL                | Yes                                                                                          | Yes (Magic SQL)           |
| NL to Python code        | Yes (generates + executes)                                                                   | Yes (Magic Python)        |
| NL to chart              | Yes (auto-selects from 42+ types)                                                            | Yes (Magic Chart)         |
| Code explain/debug       | No                                                                                           | Yes (Magic Explain/Debug) |
| Code edit via NL         | No                                                                                           | Yes (Magic Edit)          |
| Schema-aware generation  | Yes                                                                                          | Yes                       |
| Multi-provider LLM       | Yes (7 providers: Anthropic, OpenAI, Bedrock, Vertex, Ollama, llama.cpp, MLX)                | No (Hex's own model)      |
| Local/offline LLM        | Yes (MLX, llama.cpp, Ollama)                                                                 | No                        |
| Output style control     | Yes (6 styles: dashboard, narrative, executive summary, deep analysis, presentation, report) | No                        |
| Drill-down re-analysis   | Yes (click chart segment, get new analysis)                                                  | No (manual re-query)      |
| Follow-up questions      | Yes (conversation context preserved)                                                         | Partial (within Magic)    |
| Suggested explorations   | No                                                                                           | Yes                       |

**Hermetic wins on AI autonomy** — one question produces a complete, styled dashboard with no coding. **Hex wins on AI-assisted coding** — inline code modification, debugging, and explanation.

---

## Visualization

| Feature                                             | Hermetic                                     | Hex                                   |
| --------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| Native chart types                                  | 42+ (AI-selected)                            | ~14 built-in                          |
| No-code chart creation                              | AI-driven (fully automatic)                  | Manual drag-and-drop builder          |
| Code-based charts                                   | Sandbox Python (matplotlib, plotly, seaborn) | Full Python environment (any library) |
| **Basic Charts**                                    |                                              |                                       |
| Bar (grouped, stacked, horizontal)                  | Yes                                          | Yes                                   |
| Line (multi-series, stepped)                        | Yes                                          | Yes                                   |
| Area (stacked, overlaid)                            | Yes                                          | Yes                                   |
| Pie / Donut                                         | Yes                                          | Yes                                   |
| Scatter (with regression)                           | Yes                                          | Yes                                   |
| Histogram                                           | Yes                                          | Yes                                   |
| **Distribution**                                    |                                              |                                       |
| Box Plot                                            | Yes                                          | Via Python                            |
| Violin                                              | Yes                                          | Via Python                            |
| Ridgeline (joy plots)                               | Yes                                          | Via Python                            |
| Beeswarm                                            | Yes                                          | Via Python                            |
| **Hierarchical**                                    |                                              |                                       |
| Treemap                                             | Yes                                          | Via Python                            |
| Sunburst                                            | Yes                                          | Via Python                            |
| **Network & Flow**                                  |                                              |                                       |
| Sankey                                              | Yes (native)                                 | Via Python                            |
| Chord diagram                                       | Yes (native)                                 | Via Python                            |
| Stream chart                                        | Yes (native)                                 | Via Python                            |
| **Comparison & Ranking**                            |                                              |                                       |
| Bump chart                                          | Yes                                          | Via Python                            |
| Dumbbell / Slope                                    | Yes                                          | Via Python                            |
| Bullet chart                                        | Yes                                          | Via Python                            |
| Waterfall                                           | Yes                                          | Via Python                            |
| Marimekko                                           | Yes                                          | Via Python                            |
| Radar / Spider                                      | Yes                                          | Via Python                            |
| **ML / Statistical**                                |                                              |                                       |
| Confusion matrix                                    | Yes (native)                                 | Via Python                            |
| ROC / PR curve                                      | Yes (native)                                 | Via Python                            |
| SHAP beeswarm                                       | Yes (native)                                 | Via Python                            |
| Decision tree                                       | Yes (native)                                 | Via Python                            |
| Parallel coordinates                                | Yes                                          | Via Python                            |
| **Financial**                                       |                                              |                                       |
| Candlestick (OHLC)                                  | Yes (native)                                 | Via Python                            |
| **Geographic**                                      |                                              |                                       |
| 2D Map (markers + choropleth)                       | Yes (MapLibre)                               | Via Folium/Plotly                     |
| 3D Globe (arcs + points)                            | Yes (react-globe.gl)                         | No                                    |
| 3D Deck.gl (hexagon, column, arc, heatmap, scatter) | Yes (5 layer types)                          | No                                    |
| **Calendar**                                        |                                              |                                       |
| Calendar heatmap                                    | Yes (GitHub-style)                           | Via Python                            |
| **Data Display**                                    |                                              |                                       |
| Data table (sort, filter, paginate)                 | Yes                                          | Yes (with sparklines)                 |
| Stat cards / KPI                                    | Yes (with trend indicators)                  | Yes (Big Number)                      |
| Pivot tables                                        | No                                           | Yes                                   |
| Conditional formatting                              | Tables only                                  | Yes                                   |

**Hermetic wins on out-of-the-box chart diversity** — 42+ native types auto-selected by AI. No code needed for any of them. **Hex wins on unlimited customization** — any Python library, any chart, fully programmable.

---

## Interactive App Building

| Feature                | Hermetic                                            | Hex                                                                                       |
| ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Input widgets          | SelectControl, NumberInput, ToggleSwitch            | Full suite (dropdowns, sliders, date pickers, multi-select, file upload, radio, checkbox) |
| Reactive state         | Yes (DataController pipelines)                      | Yes (cell dependency graph)                                                               |
| What-if / calculators  | Yes (compute ops: multiply, percentOf, ratio, etc.) | Yes (via Python cells)                                                                    |
| Client-side filtering  | Yes (DataController with cross-chart filtering)     | Yes (filter cells + reactive re-execution)                                                |
| Layout builder         | AI-generated (grid, row, column)                    | Manual drag-and-drop                                                                      |
| App publishing         | No (single-user tool)                               | Yes (publish as standalone web app)                                                       |
| Tabs/sections          | Yes (AI-composed)                                   | Yes (manual)                                                                              |
| Button triggers        | No                                                  | Yes                                                                                       |
| Conditional visibility | No                                                  | Yes                                                                                       |
| Reusable components    | No                                                  | Yes (Components — reusable notebook fragments)                                            |

**Hex wins on app-building maturity** — it's their core product. **Hermetic wins on zero-effort composition** — AI generates the entire interactive layout automatically.

---

## Collaboration & Sharing

| Feature                       | Hermetic      | Hex                                    |
| ----------------------------- | ------------- | -------------------------------------- |
| Real-time multiplayer editing | No            | Yes (Google Docs-style)                |
| Comments/threads              | No            | Yes                                    |
| Version history               | No            | Yes (full, with restore/fork)          |
| Git integration               | No            | Yes (GitHub, GitLab)                   |
| Role-based access (RBAC)      | No            | Yes (Admin, Editor, Viewer, Publisher) |
| Workspace organization        | No            | Yes (Collections, status workflows)    |
| Published apps                | No            | Yes (standalone web apps)              |
| Scheduled runs (cron)         | No            | Yes (with email/Slack delivery)        |
| Embed in other tools          | No            | Yes (iframe)                           |
| API-triggered runs            | No            | Yes (REST API)                         |
| Review workflows              | No            | Yes (Draft/In Review/Published)        |
| Shared data connections       | No (per-user) | Yes (workspace-level)                  |

**Hex wins decisively on collaboration.** Hermetic is a single-user, local-first tool.

---

## Export & Distribution

| Feature                 | Hermetic                    | Hex |
| ----------------------- | --------------------------- | --- |
| PDF                     | Yes (themed, multi-page A4) | Yes |
| DOCX (Word)             | Yes                         | No  |
| PPTX (PowerPoint)       | Yes                         | No  |
| PNG (individual charts) | Yes (2x resolution)         | Yes |
| CSV (table data)        | Yes                         | Yes |
| XLSX (multi-sheet)      | Yes                         | No  |
| Shareable links         | No                          | Yes |
| Scheduled email reports | No                          | Yes |
| Slack integration       | No                          | Yes |
| Notion/Confluence embed | No                          | Yes |

**Hermetic wins on document export** — Word, PowerPoint, multi-sheet Excel are unique. **Hex wins on automated distribution** — scheduled emails, Slack, embeds.

---

## Code & Transparency

| Feature                 | Hermetic                                      | Hex                            |
| ----------------------- | --------------------------------------------- | ------------------------------ |
| View generated SQL      | Yes (artifact panel with syntax highlighting) | N/A (user writes SQL)          |
| View generated Python   | Yes (full code, downloadable)                 | N/A (user writes Python)       |
| Download generated code | Yes                                           | Yes (Git export)               |
| Notebook IDE            | No (AI-generated only)                        | Yes (full notebook with cells) |
| SQL cells               | No (AI generates SQL)                         | Yes (first-class)              |
| Python cells            | No (AI generates Python)                      | Yes (full environment)         |
| R support               | No                                            | Yes                            |
| Custom pip packages     | Sandbox-constrained                           | pip install anything           |
| Reusable logic          | No                                            | Yes (Components)               |

**Hex wins on code flexibility** — it's a full IDE. **Hermetic wins on transparency** — surfaces exactly what AI generated so you can verify and export it.

---

## Privacy & Deployment

| Feature                    | Hermetic                 | Hex                                                             |
| -------------------------- | ------------------------ | --------------------------------------------------------------- |
| Self-hosted                | Yes                      | No                                                              |
| Fully offline / air-gapped | Yes (Docker + local LLM) | No                                                              |
| Data stays on-premise      | Yes (always)             | No (SaaS; SQL runs on your warehouse, Python runs on Hex infra) |
| Open source                | Yes                      | No                                                              |
| No vendor lock-in          | Yes (standard formats)   | No (proprietary notebook format)                                |
| SOC 2 compliance           | N/A (self-hosted)        | Enterprise tier only                                            |
| SSO/SAML                   | No                       | Enterprise tier                                                 |
| Audit logs                 | No                       | Enterprise tier                                                 |
| VPC / Private Link         | No                       | Enterprise tier                                                 |

**Hermetic wins on privacy and control.** Data never leaves your machine. No SaaS dependency. **Hex wins on enterprise compliance** features (SOC 2, SSO, audit logs) for organizations that need them.

---

## Pricing Comparison

|                | Hermetic      | Hex Community | Hex Professional | Hex Team        | Hex Enterprise |
| -------------- | ------------- | ------------- | ---------------- | --------------- | -------------- |
| **Price**      | Free (OSS)    | $0            | ~$49/user/mo     | ~$65-75/user/mo | Custom         |
| Users          | Unlimited     | 1             | Small teams      | Full teams      | Org-wide       |
| Compute        | Your hardware | Limited hours | More hours       | Full            | Custom         |
| Scheduled runs | N/A           | No            | Yes              | Yes             | Yes            |
| SSO            | N/A           | No            | No               | Yes             | Yes            |
| Published apps | N/A           | Limited       | Yes              | Yes             | Yes            |

**Hermetic's cost advantage:** A team of 10 analysts on Hex Team costs ~$750/month. Hermetic costs $0 plus your own compute. The tradeoff is self-hosting responsibility and no collaboration features.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **question to dashboard in seconds** with no coding
- **Data privacy is non-negotiable** (air-gapped, on-prem, regulated industries)
- You need **42+ chart types selected automatically** by AI
- You want **rich document exports** (PowerPoint, Word, multi-sheet Excel)
- You want to **use your own LLM** or run models locally
- You're a **solo analyst or small team** without collaboration needs
- You want **zero vendor lock-in** and full control

### Choose Hex when:

- You need a **collaborative notebook for a data team**
- You want to **build and publish interactive web applications**
- You need **13+ native warehouse connectors** (especially Snowflake, Databricks, Redshift)
- You want a **full Python/R IDE** with custom packages
- You need **scheduled reports, embedding, and stakeholder distribution**
- You want **inline AI code editing and debugging**
- You need **enterprise compliance** (SOC 2, SSO, audit logs)

### The Fundamental Difference

**Hermetic** is an **AI-first analysis tool** that generates complete dashboards from a single question. It replaces the analyst workflow for routine questions.

**Hex** is a **code-first notebook platform** that augments human coding with AI assistance. It empowers the analyst with better tools for complex exploration.

They serve different workflows. Hermetic is for "give me the answer." Hex is for "help me find the answer."

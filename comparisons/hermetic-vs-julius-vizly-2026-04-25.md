# Hermetic vs Julius AI & Vizly — Competitive Feature Comparison

_Last updated: 2026-04-25_

These are the closest direct competitors to Hermetic in the "upload data, ask question, get visualization" category. Both are cloud-only SaaS products targeting individual analysts and researchers.

---

## Overview

| Category        | Hermetic                                        | Julius AI                                                     | Vizly                                        |
| --------------- | ----------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------- |
| **Core Model**  | Question → multi-widget dashboard, single shot  | Chat thread + agentic workflows (Bloom agents, Custom Agents) | Chat with pinnable charts, AI data analyst   |
| **Deployment**  | Self-hosted / local-first                       | Cloud SaaS only                                               | Cloud SaaS only                              |
| **Pricing**     | Free (open source)                              | Free (15 msg/mo) → Plus → Pro $45/mo → Business → Enterprise  | Free → paid (limited public pricing)         |
| **Target User** | Privacy-conscious analyst, regulated industries | Students, researchers, business teams (Pro+ for warehouses)   | Casual data explorers, SPSS / academic users |
| **Open Source** | Yes (MIT)                                       | No                                                            | No                                           |
| **Status**      | Active, frequent releases                       | Active, expanded with Bloom agentic workflows                 | Active (Y Combinator, $500K seed, Montreal)  |
| **Privacy**     | Data + LLM context stay on your machine         | Cloud-processed; SOC 2 claimed                                | Cloud-processed                              |

---

## Data Sources

| Feature                         | Hermetic                                       | Julius AI                                   | Vizly                  |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------- | ---------------------- |
| CSV                             | Yes (100MB)                                    | Yes                                         | Yes                    |
| Excel (.xlsx)                   | Yes (multi-sheet + FK relationship detection)  | Yes                                         | Yes                    |
| GeoJSON                         | Yes (native, auto geometry detection)          | No                                          | No                     |
| JSON                            | Via GeoJSON path                               | Yes                                         | Yes                    |
| Parquet (single + Hive folders) | **Yes (DuckDB-backed, zero-copy bind-mount)**  | No                                          | No                     |
| SPSS (.sav)                     | No                                             | No                                          | Yes (a Vizly hallmark) |
| PDF table extraction            | No                                             | Yes (uploads)                               | Yes                    |
| Google Sheets                   | No                                             | Yes (via link or Google Drive connector)    | No                     |
| Local file browser (host fs)    | **Yes (bind-mounted into sandbox, read-only)** | No                                          | No                     |
| **Warehouse Connectors**        |                                                |                                             |                        |
| PostgreSQL                      | Yes                                            | Yes (Pro+)                                  | No                     |
| BigQuery                        | Yes                                            | Yes (Pro+)                                  | No                     |
| Snowflake                       | No                                             | Yes (Pro+)                                  | No                     |
| Databricks                      | No                                             | Yes (Pro+)                                  | No                     |
| MySQL                           | No                                             | Yes (Pro+)                                  | No                     |
| SQL Server                      | No                                             | Yes (Pro+)                                  | No                     |
| Supabase                        | Yes (PG-wire compatible)                       | Yes (Pro+)                                  | No                     |
| ClickHouse                      | Yes                                            | No                                          | No                     |
| Trino / Hive                    | Yes                                            | No                                          | No                     |
| **App / SaaS Connectors**       |                                                |                                             |                        |
| Google Drive / OneDrive         | No                                             | Yes                                         | No                     |
| Google Ads / Stripe             | No                                             | Yes                                         | No                     |
| **AI behavior**                 |                                                |                                             |                        |
| Warehouse SQL generation        | Yes (dialect-aware, cross-table JOINs)         | Yes (semantic layer auto-built from schema) | No                     |
| Custom Agents / saved workflows | No                                             | Yes (Pro+ — define analytical processes)    | No                     |

**Hermetic wins on warehouse breadth among free tools** — 5 native warehouse connectors plus Parquet and local-file zero-copy ingestion. **Julius wins on warehouse breadth overall** — 6+ warehouse connectors plus SaaS sources (Google Ads, Stripe, Drive), but only on Pro and above. **Vizly wins on file-format niches** — SPSS and PDF table extraction.

---

## AI / LLM Capabilities

| Feature                       | Hermetic                                                                     | Julius AI                                                    | Vizly                         |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------- |
| NL to complete dashboard      | Yes (multi-widget JSON-Render layout, one prompt)                            | Partial (single-chart per message; Bloom agents chain steps) | No (single chart per message) |
| NL to chart                   | Yes (auto-selects from 35+ types)                                            | Yes (~12 types)                                              | Yes (~8-10 types)             |
| NL to statistical analysis    | Via generated Python (sandbox)                                               | Yes (regression, hypothesis tests, forecasting)              | Basic                         |
| Agentic workflows             | No (single-shot)                                                             | Yes (Bloom autonomous agents on Plus+)                       | Limited                       |
| Code generation               | Yes (Python, visible + downloadable)                                         | Yes (Python, visible + editable inline)                      | Yes (Python, visible)         |
| Code editing                  | No (regenerate via follow-up)                                                | Yes (edit generated code inline)                             | No                            |
| Multi-provider LLM            | Yes (7 providers)                                                            | No (Julius-managed model selection)                          | No                            |
| Local / offline LLM           | Yes (MLX, llama.cpp, Ollama)                                                 | No                                                           | No                            |
| Output styles / purpose modes | 6 (Infographic, Narrative, Executive Summary, Deep Analysis, Slides, Report) | No (chat format only)                                        | No                            |
| Drill-down re-analysis        | Yes (click chart segment → new analysis)                                     | No                                                           | No                            |
| Follow-up questions           | Yes (server-side conversation cache, 5 turns)                                | Yes (chat thread)                                            | Yes (chat thread)             |
| Sandbox execution             | Yes (Docker, Microsandbox microVM, E2B)                                      | Yes (server-side sandbox)                                    | Yes (server-side sandbox)     |
| Schema-only privacy mode      | **Yes — LLM never sees row values**                                          | No (data flows through cloud)                                | No                            |
| Schema-aware code-gen         | Yes (types, distributions, correlations, FK relationships)                   | Yes (semantic layer of warehouse schema)                     | Basic                         |
| Methodology display           | Yes (plain-English summary on every analysis)                                | Visible in code                                              | Visible in code               |
| Suggested questions           | Yes (LLM-generated from schema on file load)                                 | Limited                                                      | Limited                       |

**Hermetic wins on output composition and privacy** — single-prompt multi-component dashboards with 6 distinct output styles, and the LLM operates on schema only. **Julius wins on agentic depth and warehouse semantics** — Bloom agents, Custom Agents, inline code editing, automatic semantic-layer construction over warehouse schemas.

---

## Visualization

| Feature                                 | Hermetic                                         | Julius AI         | Vizly                 |
| --------------------------------------- | ------------------------------------------------ | ----------------- | --------------------- |
| Native chart types                      | 35+                                              | ~10-12            | ~8-10                 |
| **Basic Charts**                        |                                                  |                   |                       |
| Bar / Line / Area / Pie / Scatter       | Yes                                              | Yes               | Yes                   |
| Histogram                               | Yes                                              | Yes               | Yes                   |
| **Distribution**                        |                                                  |                   |                       |
| Box Plot                                | Yes                                              | Via code          | No                    |
| Violin / Ridgeline / Beeswarm           | Yes                                              | No                | No                    |
| **Hierarchical**                        |                                                  |                   |                       |
| Treemap / Sunburst                      | Yes                                              | No                | No                    |
| **Network & Flow**                      |                                                  |                   |                       |
| Sankey / Chord / Stream                 | Yes                                              | No                | No                    |
| **Comparison**                          |                                                  |                   |                       |
| Bump / Dumbbell / Bullet / Waterfall    | Yes                                              | No                | No                    |
| Marimekko / Radar                       | Yes                                              | No                | No                    |
| **Geographic**                          |                                                  |                   |                       |
| 2D Map (MapLibre)                       | Yes                                              | Via code (Folium) | No                    |
| 3D Globe (with arc filtering)           | Yes                                              | No                | No                    |
| Deck.gl 3D Maps (5 layers)              | Yes                                              | No                | No                    |
| **3D Plots**                            |                                                  |                   |                       |
| Scatter3D / Surface3D                   | Yes                                              | Via code          | No                    |
| **ML / Statistical**                    |                                                  |                   |                       |
| ROC / Confusion Matrix / SHAP           | Yes (native)                                     | Via code          | No                    |
| Decision Tree / Parallel Coordinates    | Yes (native)                                     | No                | No                    |
| **Financial**                           |                                                  |                   |                       |
| Candlestick                             | Yes                                              | Via code          | No                    |
| **Calendar**                            |                                                  |                   |                       |
| Calendar heatmap                        | Yes                                              | No                | No                    |
| **Data Display**                        |                                                  |                   |                       |
| Data table (sort, filter, paginate)     | Yes                                              | Yes (basic)       | Yes (basic)           |
| Stat cards with trends                  | Yes (StatCard + TrendIndicator)                  | No                | No                    |
| **Layout**                              |                                                  |                   |                       |
| Multi-widget dashboard layout           | Yes (LayoutGrid, LayoutRow, LayoutColumn)        | No (chat thread)  | Basic (pinned charts) |
| Interactive controls (filters, what-if) | Yes (SelectControl, NumberInput, DataController) | No                | No                    |
| Cross-chart filtering                   | Yes (sub-second client-side)                     | No                | No                    |
| Drill-down (click → re-analyze)         | Yes                                              | No                | No                    |

**Hermetic wins overwhelmingly on visualization** — 35+ native types vs ~10 for Julius and ~8 for Vizly. More importantly, Hermetic composes them into coherent multi-widget dashboards; Julius and Vizly produce one chart at a time in a chat thread.

---

## Interactive Features

| Feature            | Hermetic                                                            | Julius AI                | Vizly             |
| ------------------ | ------------------------------------------------------------------- | ------------------------ | ----------------- |
| Dashboard layout   | AI-generated (grid, columns)                                        | No (chat thread)         | Basic (pin board) |
| Drill-down         | Yes (click to re-analyze with filtered context)                     | No                       | No                |
| Cross-filtering    | Yes (DataController)                                                | No                       | No                |
| Dynamic inputs     | Yes (SelectControl, NumberInput, ToggleSwitch, TextInput, TextArea) | No                       | No                |
| What-if analysis   | Yes (reactive state, compute pipelines)                             | Limited (via code edits) | No                |
| Hover tooltips     | Yes (Plotly, Nivo, deck.gl)                                         | Yes (Plotly)             | Yes (Plotly)      |
| Chart zoom/pan     | Yes                                                                 | Yes                      | Yes               |
| Chart fullscreen   | Yes (every chart, dynamic legend repositioning)                     | Yes                      | Yes               |
| Persistent history | Yes (auto-saved, replay, restore)                                   | Chat thread persistence  | Pinned charts     |

**Hermetic wins on interactivity.** Julius and Vizly are largely static chat outputs.

---

## Statistical / ML Features

| Feature                                              | Hermetic                                                                | Julius AI                    | Vizly   |
| ---------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- | ------- |
| Regression / hypothesis tests                        | Yes (via generated Python)                                              | Yes (first-class capability) | Basic   |
| Forecasting / time series                            | Yes (via Python/sandbox; statsmodels available)                         | Yes                          | Limited |
| Anomaly / outlier detection                          | Yes (via Python; plus auto-detected in schema)                          | Yes                          | No      |
| Statistical schema metadata                          | Yes (skewness, kurtosis, percentiles, correlations, distribution shape) | Limited                      | Limited |
| ML chart types (ROC, confusion, SHAP, decision tree) | Yes (native)                                                            | Via code                     | No      |
| Auto-generated insights                              | Yes (data-domain detection: financial, time-series, statistical)        | Limited                      | No      |

**Tie / context-dependent.** Both Hermetic and Julius can do meaningful statistical work; Julius leans into the _interactive statistical workflow_ (edit code, re-run, ask follow-ups); Hermetic surfaces statistics through native chart types and rich schema metadata fed into the LLM.

---

## Export

| Feature                    | Hermetic                    | Julius AI           | Vizly |
| -------------------------- | --------------------------- | ------------------- | ----- |
| PDF                        | Yes (themed, multi-page A4) | Yes (Pro)           | No    |
| DOCX                       | Yes (landscape)             | No                  | No    |
| PPTX                       | Yes (single slide)          | No                  | No    |
| PNG                        | Yes (2× pixel ratio)        | Yes                 | Yes   |
| CSV                        | Yes                         | Yes                 | Yes   |
| XLSX (multi-sheet, styled) | Yes                         | No                  | No    |
| Code download              | Yes (Python script)         | Yes (copy/download) | No    |
| Share link                 | No                          | Yes                 | No    |
| Embed                      | No                          | Limited             | No    |

**Hermetic wins on export** — professional document formats (DOCX, PPTX, multi-sheet styled XLSX) that Julius and Vizly lack entirely. Julius wins on share links.

---

## Privacy & Deployment

| Feature                 | Hermetic                      | Julius AI                                     | Vizly                  |
| ----------------------- | ----------------------------- | --------------------------------------------- | ---------------------- |
| Self-hosted             | Yes                           | No                                            | No                     |
| Fully offline           | Yes (Docker + local LLM)      | No                                            | No                     |
| Data stays local        | Yes (always)                  | No (uploaded to cloud)                        | No (uploaded to cloud) |
| LLM never sees row data | **Yes (schema-only context)** | No (data flows through AI for code execution) | No                     |
| Open source             | Yes (MIT)                     | No                                            | No                     |
| SOC 2                   | N/A (self-hosted)             | Claimed                                       | Unknown                |
| SSO / SAML              | No                            | Enterprise tier                               | Unknown                |
| Audit logs / RBAC       | No                            | Enterprise tier                               | Unknown                |
| Data retention          | Permanent (your disk)         | Plan-dependent (Plus 7 days, Pro extended)    | Unknown                |
| Data used for training  | No                            | Per policy: not used                          | Unknown                |

**Hermetic wins decisively on privacy.** Data never leaves your machine, and the LLM operates on schema and statistics — never on row values. Julius and Vizly upload data to their cloud servers and pass it through their AI infrastructure.

---

## Pricing Comparison (April 2026)

|                                   | Hermetic  | Julius Free | Julius Plus (Bloom $19.90+ / Chat $3.90+) | Julius Pro (~$45/mo)                                        | Julius Business / Enterprise | Vizly Free | Vizly Paid             |
| --------------------------------- | --------- | ----------- | ----------------------------------------- | ----------------------------------------------------------- | ---------------------------- | ---------- | ---------------------- |
| **Price**                         | Free      | $0          | from $3.90–$19.90/mo                      | ~$45/mo (~$37 ann.)                                         | Custom                       | $0         | Public pricing limited |
| Messages/mo                       | Unlimited | 15          | Plan-dependent                            | Unlimited                                                   | Unlimited                    | ~10        | More                   |
| File size                         | 100MB     | ~50MB       | Larger                                    | Larger                                                      | Custom                       | Small      | Larger                 |
| Live database connectors          | 5         | 0           | 0                                         | 6+ (PG, Snowflake, BigQuery, MySQL, SQL Server, Databricks) | + SSO, RBAC, audit           | 0          | 0                      |
| Custom Agents / agentic workflows | No        | No          | Plus (Bloom)                              | Yes                                                         | Yes                          | No         | No                     |
| Chart types                       | 35+       | ~10         | ~10                                       | ~12                                                         | ~12                          | ~8         | ~8                     |
| Dashboard layout                  | Yes (AI)  | No          | No                                        | No                                                          | No                           | Basic      | Basic                  |
| Offline mode                      | Yes       | No          | No                                        | No                                                          | No                           | No         | No                     |
| Self-hosted                       | Yes       | No          | No                                        | No                                                          | No                           | No         | No                     |
| BYO LLM                           | Yes (7)   | No          | No                                        | No                                                          | Limited                      | No         | No                     |

15% off annual on Julius. 50% off all Julius plans for students/educators.

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

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **complete multi-widget dashboards** from a single question, with no cell-by-cell follow-ups
- **Data privacy matters** (regulated industries, sensitive data, air-gapped environments)
- You want the **LLM to never see your data** (schema + statistics only)
- You need **35+ chart types** including maps, 3D, ML-specific, and financial visualizations
- You want **warehouse connectivity** (PostgreSQL, BigQuery, ClickHouse, Trino, Hive) without subscribing to a cloud SaaS
- You need **document exports** (PDF, DOCX, PPTX, multi-sheet XLSX)
- You want to **choose your LLM** or run models locally (Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)
- You want **zero cost** with no message limits
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

**Hermetic** produces a **complete, interactive dashboard** — stat cards, charts, tables, narrative text, filters, drill-downs — all composed and laid out by AI from a single question, with **the LLM never seeing your data**.

**Julius and Vizly** produce **one chart per message** in a chat thread, sending your data to the cloud. Julius adds agentic workflows on top (Bloom autonomous agents, Custom Agents) for iterative analysis. Vizly is the simpler conversational counterpart with niche format support.

Hermetic replaces the workflow. Julius and Vizly assist within it.

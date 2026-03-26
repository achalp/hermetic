# Hermetic vs Julius AI & Vizly — Competitive Feature Comparison

_Last updated: 2026-03-24_

These are the closest direct competitors to Hermetic in the "upload data, ask question, get visualization" category. Both are cloud-only SaaS products targeting individual analysts and researchers.

---

## Overview

| Category        | Hermetic                           | Julius AI                           | Vizly                            |
| --------------- | ---------------------------------- | ----------------------------------- | -------------------------------- |
| **Core Model**  | Question to multi-widget dashboard | Chat thread with per-message charts | Chat with pinnable charts        |
| **Deployment**  | Self-hosted / local-first          | Cloud SaaS only                     | Cloud SaaS only                  |
| **Pricing**     | Free (open source)                 | Free (15 msg/mo), Pro ~$35/mo       | Free (limited), paid tiers       |
| **Target User** | Privacy-conscious analyst          | Students, researchers, prosumers    | Casual data explorers            |
| **Open Source** | Yes                                | No                                  | No                               |
| **Status**      | Active                             | Active                              | Uncertain (may be sunset/merged) |

---

## Data Sources

| Feature                  | Hermetic                              | Julius AI      | Vizly |
| ------------------------ | ------------------------------------- | -------------- | ----- |
| CSV                      | Yes (100MB)                           | Yes            | Yes   |
| Excel (.xlsx)            | Yes (multi-sheet + FK detection)      | Yes            | Yes   |
| GeoJSON                  | Yes (native, auto geometry detection) | No             | No    |
| JSON                     | Via GeoJSON                           | Yes            | Yes   |
| SPSS                     | No                                    | No             | Yes   |
| PDF table extraction     | No                                    | No             | Yes   |
| Google Sheets            | No                                    | Yes (via link) | No    |
| PostgreSQL               | Yes                                   | Yes (limited)  | No    |
| BigQuery                 | Yes                                   | No             | No    |
| ClickHouse               | Yes                                   | No             | No    |
| Trino                    | Yes                                   | No             | No    |
| Hive                     | Yes                                   | No             | No    |
| Warehouse SQL generation | Yes (AI generates SQL from NL)        | No             | No    |

**Hermetic wins on data source breadth** — 5 warehouse connectors plus rich file support. Julius is primarily file-upload. Vizly is file-only.

---

## AI / LLM Capabilities

| Feature                    | Hermetic                                                        | Julius AI                            | Vizly                         |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------ | ----------------------------- |
| NL to complete dashboard   | Yes (multi-widget layout)                                       | No (single chart per message)        | No (single chart per message) |
| NL to chart                | Yes (auto-selects from 42+ types)                               | Yes (~10 types)                      | Yes (~8 types)                |
| NL to statistical analysis | Via generated Python                                            | Yes (regression, hypothesis testing) | Basic                         |
| Code generation            | Yes (Python, visible + downloadable)                            | Yes (Python, visible + editable)     | Yes (Python, visible)         |
| Code editing               | No (regenerate via follow-up)                                   | Yes (edit generated code inline)     | No                            |
| Multi-provider LLM         | Yes (7 providers)                                               | No (OpenAI-based)                    | No (OpenAI-based)             |
| Local/offline LLM          | Yes (MLX, llama.cpp, Ollama)                                    | No                                   | No                            |
| Output styles              | 6 (dashboard, narrative, executive, deep, presentation, report) | No (chat format only)                | No                            |
| Drill-down re-analysis     | Yes (click chart segment)                                       | No                                   | No                            |
| Follow-up questions        | Yes (conversation context)                                      | Yes (chat thread)                    | Yes (chat thread)             |
| Sandbox execution          | Yes (Docker, E2B, microsandbox)                                 | Yes (server-side sandbox)            | Yes (server-side sandbox)     |
| Schema-aware               | Yes (auto-detected types, statistics, correlations)             | Basic (column detection)             | Basic                         |

**Hermetic wins on output quality** — generates complete dashboards with multiple components, not just individual charts. **Julius wins on code interactivity** — users can edit generated code inline.

---

## Visualization

| Feature                              | Hermetic                                  | Julius AI         | Vizly                 |
| ------------------------------------ | ----------------------------------------- | ----------------- | --------------------- |
| Native chart types                   | 42+                                       | ~10-12            | ~8-10                 |
| **Basic Charts**                     |                                           |                   |                       |
| Bar / Line / Area / Pie / Scatter    | Yes                                       | Yes               | Yes                   |
| Histogram                            | Yes                                       | Yes               | Yes                   |
| **Distribution**                     |                                           |                   |                       |
| Box Plot                             | Yes                                       | Via code          | No                    |
| Violin / Ridgeline / Beeswarm        | Yes                                       | No                | No                    |
| **Hierarchical**                     |                                           |                   |                       |
| Treemap / Sunburst                   | Yes                                       | No                | No                    |
| **Network & Flow**                   |                                           |                   |                       |
| Sankey / Chord / Stream              | Yes                                       | No                | No                    |
| **Comparison**                       |                                           |                   |                       |
| Bump / Dumbbell / Bullet / Waterfall | Yes                                       | No                | No                    |
| **Geographic**                       |                                           |                   |                       |
| 2D Map (MapLibre)                    | Yes                                       | Via code (Folium) | No                    |
| 3D Globe                             | Yes                                       | No                | No                    |
| Deck.gl 3D Maps                      | Yes                                       | No                | No                    |
| **ML / Statistical**                 |                                           |                   |                       |
| ROC / Confusion Matrix / SHAP        | Yes (native)                              | Via code          | No                    |
| Decision Tree                        | Yes                                       | No                | No                    |
| **Financial**                        |                                           |                   |                       |
| Candlestick                          | Yes                                       | Via code          | No                    |
| **Data Display**                     |                                           |                   |                       |
| Data table (sort, filter, paginate)  | Yes                                       | Yes (basic)       | Yes (basic)           |
| Stat cards with trends               | Yes                                       | No                | No                    |
| **Layout**                           |                                           |                   |                       |
| Multi-widget dashboard layout        | Yes (LayoutGrid, LayoutRow, LayoutColumn) | No (chat thread)  | Basic (pinned charts) |
| Interactive controls (filters)       | Yes (SelectControl, DataController)       | No                | No                    |
| Cross-chart filtering                | Yes                                       | No                | No                    |

**Hermetic wins overwhelmingly on visualization** — 42+ native types vs ~10 for Julius and ~8 for Vizly. More importantly, Hermetic composes them into coherent multi-widget dashboards; Julius and Vizly produce one chart at a time in a chat thread.

---

## Interactive Features

| Feature          | Hermetic                         | Julius AI        | Vizly             |
| ---------------- | -------------------------------- | ---------------- | ----------------- |
| Dashboard layout | AI-generated (grid, columns)     | No (chat thread) | Basic (pin board) |
| Drill-down       | Yes (click to re-analyze)        | No               | No                |
| Cross-filtering  | Yes (DataController)             | No               | No                |
| Dynamic inputs   | Yes (SelectControl, NumberInput) | No               | No                |
| What-if analysis | Yes (reactive state)             | No               | No                |
| Hover tooltips   | Yes (Plotly/Nivo)                | Yes (Plotly)     | Yes (Plotly)      |
| Chart zoom/pan   | Yes                              | Yes              | Yes               |

**Hermetic wins on interactivity.** Julius and Vizly are static chat outputs.

---

## Export

| Feature            | Hermetic                 | Julius AI           | Vizly |
| ------------------ | ------------------------ | ------------------- | ----- |
| PDF                | Yes (themed, multi-page) | No                  | No    |
| DOCX               | Yes                      | No                  | No    |
| PPTX               | Yes                      | No                  | No    |
| PNG                | Yes (2x resolution)      | Yes                 | Yes   |
| CSV                | Yes                      | Yes                 | Yes   |
| XLSX (multi-sheet) | Yes                      | No                  | No    |
| Code download      | Yes                      | Yes (copy/download) | No    |
| Share link         | No                       | Yes                 | No    |

**Hermetic wins on export** — professional document formats that Julius and Vizly lack entirely.

---

## Privacy & Deployment

| Feature                | Hermetic                 | Julius AI               | Vizly                  |
| ---------------------- | ------------------------ | ----------------------- | ---------------------- |
| Self-hosted            | Yes                      | No                      | No                     |
| Fully offline          | Yes (Docker + local LLM) | No                      | No                     |
| Data stays local       | Yes (always)             | No (uploaded to cloud)  | No (uploaded to cloud) |
| Open source            | Yes                      | No                      | No                     |
| SOC 2                  | N/A (self-hosted)        | Claimed                 | Unknown                |
| Data retention         | Permanent (your disk)    | 7 days on Plus tier     | Unknown                |
| Data used for training | No                       | "Not used" (per policy) | Unknown                |

**Hermetic wins decisively on privacy.** Data never leaves your machine. Julius and Vizly upload data to their cloud servers.

---

## Pricing Comparison

|                      | Hermetic  | Julius Free  | Julius Pro | Vizly Free | Vizly Paid |
| -------------------- | --------- | ------------ | ---------- | ---------- | ---------- |
| **Price**            | Free      | $0           | ~$35/mo    | $0         | Unknown    |
| Messages/mo          | Unlimited | ~15          | Unlimited  | ~10        | More       |
| File size            | 100MB     | ~50MB        | Larger     | Small      | Larger     |
| Data retention       | Permanent | 7 days       | 7 days     | Session    | Unknown    |
| Warehouse connectors | 5         | 1 (Postgres) | 1          | 0          | 0          |
| Chart types          | 42+       | ~10          | ~10        | ~8         | ~8         |
| Dashboard layout     | Yes       | No           | No         | Basic      | Basic      |
| Offline mode         | Yes       | No           | No         | No         | No         |

---

## Also in This Category

Other tools competing in the "upload data, ask question, get chart" space:

| Tool                         | Key Difference from Hermetic                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| **ChatGPT Code Interpreter** | Massive distribution but no persistent dashboards, session-based, no warehouse connectors   |
| **Akkio**                    | Targets agencies with white-labeling, ML prediction focus, ~$49/mo                          |
| **Polymer Search**           | Auto-generates dashboards from spreadsheets, no-code, ~$10/mo, but no AI question answering |
| **Obviously AI**             | ML prediction focus, not ad-hoc visualization, ~$75/mo                                      |

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **complete multi-widget dashboards** from a single question
- **Data privacy matters** (regulated industries, sensitive data, air-gapped environments)
- You need **42+ chart types** including maps, 3D, ML-specific
- You want **warehouse connectivity** (PostgreSQL, BigQuery, ClickHouse, Trino, Hive)
- You need **document exports** (PDF, DOCX, PPTX, multi-sheet XLSX)
- You want to **choose your LLM** or run models locally
- You want **zero cost** with no message limits

### Choose Julius AI when:

- You want a **quick, conversational data exploration** experience
- You want to **edit generated code inline** and iterate
- You're a **student or researcher** doing exploratory/statistical analysis
- You want **code transparency** with in-context editing
- You're comfortable with **cloud data processing**
- You don't need multi-widget dashboards or warehouse connectors

### Choose Vizly when:

- You want the **simplest possible** upload-and-ask experience
- You need to **extract tables from PDFs or SPSS files**
- You want to quickly **pin charts into a simple board**
- Note: Verify product availability — Vizly's status as a standalone product is uncertain

### The Fundamental Difference

**Hermetic** produces a **complete, interactive dashboard** — stat cards, charts, tables, narrative text, filters — all composed and laid out by AI from a single question.

**Julius and Vizly** produce **one chart per message** in a chat thread. Building a coherent analysis requires asking multiple questions sequentially and mentally stitching the outputs together.

Hermetic replaces the workflow. Julius and Vizly assist within it.

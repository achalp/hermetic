# Hermetic vs Power BI Copilot — Competitive Feature Comparison

_Last updated: 2026-04-25_

## Overview

| Category        | Hermetic                                              | Power BI (with Copilot + Fabric)                                                  |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Core Model**  | AI-first: question to complete multi-widget dashboard | Enterprise BI platform + Copilot + agentic Fabric Data Agents                     |
| **Deployment**  | Self-hosted / local-first                             | Cloud (Power BI Service / Fabric) + Desktop + on-prem (Report Server, no Copilot) |
| **Pricing**     | Free (open source)                                    | Pro $14/user/mo, PPU $24/user/mo, Fabric capacity F2+ ($263/mo) for Copilot       |
| **Ecosystem**   | Standalone                                            | Microsoft 365 / Fabric / Purview ecosystem                                        |
| **Target User** | Solo analyst, privacy-first, regulated industries     | Enterprise, Microsoft-stack organizations                                         |
| **AI Posture**  | LLM never sees the data (schema-only context)         | Copilot + Fabric Data Agents have full semantic-model access (RLS-honored)        |

---

## AI / Copilot Capabilities

| Feature                         | Hermetic                                                          | Power BI Copilot (April 2026)                                                |
| ------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| NL to complete dashboard        | Yes (one prompt → multi-widget JSON-Render)                       | Yes ("Suggest a report page" — Copilot proposes visuals from semantic model) |
| NL to individual chart          | Yes (part of dashboard)                                           | Yes ("Suggest a visual" from prompt)                                         |
| NL to narrative summary         | Yes (TextBlock components, 6 styles)                              | Yes (Smart Narrative visual, Copilot summaries, AI Auto-Summary preview)     |
| NL Q&A                          | Yes (primary UX)                                                  | Yes (Copilot pane in reports; **Q&A visual deprecating December 2026**)      |
| NL to DAX / measures            | No (generates Python instead)                                     | Yes (DAX query view Copilot, GA — generate, explain, edit DAX)               |
| NL to SQL                       | Yes (5 warehouse dialects, cross-table JOINs)                     | Yes (Fabric SQL Copilot in VS Code MSSQL extension)                          |
| Standalone cross-item AI chat   | No                                                                | Yes (Standalone Copilot, preview — chat across reports/models/agents)        |
| App-scoped Copilot              | No (per-session)                                                  | Yes (preview — scoped to curated Power BI app content)                       |
| Agentic / autonomous workflows  | No (single-shot)                                                  | Yes (Fabric Data Agents GA — span up to 5 sources, RLS-aware)                |
| Multi-source data agents        | No                                                                | Yes (lakehouses, warehouses, KQL DBs, semantic models, Microsoft Graph)      |
| Explain data (anomaly insights) | No                                                                | Yes (Explain increase/decrease)                                              |
| Suggested questions             | Yes (LLM-generated from schema on file load)                      | Yes (Copilot suggests follow-ups)                                            |
| Multi-provider LLM              | Yes (7 providers + 3 local backends)                              | No (Azure OpenAI only)                                                       |
| Local / offline LLM             | Yes (MLX, llama.cpp, Ollama)                                      | No (cloud Copilot capacity required)                                         |
| Output style control            | Yes (6 styles)                                                    | No (standard report / narrative format)                                      |
| Schema-aware                    | Yes (auto-detected types, distributions, correlations)            | Yes (semantic model — measures, hierarchies, RLS)                            |
| Drill-down re-analysis          | Yes (click chart segment → new AI analysis with filtered context) | Native drill-down + drill-through; Copilot summaries on filtered context     |
| Methodology disclosure          | Yes (plain-English on every analysis)                             | Visible through generated DAX / measure descriptions                         |
| LLM prompt limit                | Provider-dependent                                                | 10,000 character prompt limit                                                |

**Power BI Copilot has matured significantly** since the 2024 baseline — Standalone Copilot, App-scoped Copilot, and especially **Fabric Data Agents** make it a genuine agentic competitor, with Microsoft Purview policies and RLS honored end-to-end. **Hermetic still wins on LLM flexibility** (7 providers, 3 local backends), **output-style variety** (6 distinct purposes), and **on-prem AI** (Copilot still does not run on Power BI Report Server).

---

## Data Sources

| Feature                                                             | Hermetic                                      | Power BI / Fabric                                                        |
| ------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| CSV upload                                                          | Yes (100MB)                                   | Yes                                                                      |
| Excel                                                               | Yes (multi-sheet + FK detection)              | Yes (deep Excel integration)                                             |
| GeoJSON native                                                      | Yes                                           | Via Shape Map / ArcGIS                                                   |
| Parquet (single + Hive folders)                                     | **Yes (DuckDB-backed, zero-copy bind-mount)** | Yes (Fabric Direct Lake mode reads OneLake Parquet/Delta without import) |
| Local file browser                                                  | **Yes (sandbox bind-mount of host fs)**       | Local file picker only                                                   |
| PostgreSQL                                                          | Yes                                           | Yes                                                                      |
| BigQuery                                                            | Yes                                           | Yes                                                                      |
| ClickHouse                                                          | Yes                                           | Via ODBC                                                                 |
| Trino / Starburst                                                   | Yes                                           | Via ODBC                                                                 |
| Hive                                                                | Yes                                           | Yes                                                                      |
| Snowflake                                                           | No                                            | Yes                                                                      |
| Databricks                                                          | No                                            | Yes                                                                      |
| Redshift / Athena                                                   | No                                            | Yes                                                                      |
| Azure SQL / Synapse                                                 | No                                            | Yes (native, optimized)                                                  |
| SQL Server / Oracle / MySQL                                         | No                                            | Yes                                                                      |
| SharePoint / Dynamics 365 / Salesforce / Workday / ServiceNow / SAP | No                                            | Yes (native enterprise apps)                                             |
| Web / OData / REST                                                  | No                                            | Yes                                                                      |
| Dataverse                                                           | No                                            | Yes (native)                                                             |
| OneLake / Fabric (Direct Lake)                                      | No                                            | Yes (native, sub-second on Parquet/Delta)                                |
| Total connectors                                                    | 5 warehouses + 5 file formats                 | **150+ connectors**                                                      |

**Power BI / Fabric wins overwhelmingly on connectors** — 150+ via the Microsoft and Power Query ecosystem, plus OneLake Direct Lake for sub-second queries on Parquet/Delta without import. **Hermetic wins on simplicity** — no data modeling required, just connect a warehouse or browse to a Parquet folder and ask.

---

## Visualization

| Feature                          | Hermetic                        | Power BI                                          |
| -------------------------------- | ------------------------------- | ------------------------------------------------- |
| Native chart types               | 35+ (AI-selected)               | ~30 built-in + AppSource marketplace              |
| Bar / Column                     | Yes                             | Yes                                               |
| Line / Area                      | Yes                             | Yes (incl. Ribbon chart)                          |
| Pie / Donut                      | Yes                             | Yes                                               |
| Scatter                          | Yes                             | Yes (incl. dot plot)                              |
| Table / Matrix                   | Yes (DataTable)                 | Yes (Matrix with drill)                           |
| KPI / Card                       | Yes (StatCard + TrendIndicator) | Yes (Card, Multi-row Card, KPI)                   |
| Gauge                            | No                              | Yes                                               |
| Funnel                           | No                              | Yes                                               |
| Waterfall                        | Yes                             | Yes                                               |
| Treemap                          | Yes                             | Yes                                               |
| Map (basic)                      | Yes (MapLibre GL)               | Yes (basic, filled, ArcGIS, Azure Map, shape map) |
| Decomposition tree               | No                              | Yes (AI-powered)                                  |
| Key influencers                  | No                              | Yes (AI-powered)                                  |
| Q&A visual                       | No                              | Yes (deprecating Dec 2026)                        |
| Smart narrative                  | TextBlock variants              | Yes (AI-powered)                                  |
| Anomaly detection visual         | No                              | Yes                                               |
| Goals / scorecard                | No                              | Yes                                               |
| R / Python visuals               | Via sandbox                     | Yes (in-report)                                   |
| Custom visuals (marketplace)     | No                              | Yes (AppSource — hundreds, certified)             |
| Visual calculations (DAX in viz) | No                              | Yes (GA)                                          |
| Translytical task flows          | No (one-way)                    | Yes (write-back from a visual)                    |
| **Hermetic-exclusive natives**   |                                 |                                                   |
| 3D Globe (with arc filtering)    | Yes                             | No                                                |
| Deck.gl 3D maps                  | Yes (5 layer types)             | No                                                |
| Sankey / Chord / Stream          | Yes (native)                    | Via custom visuals                                |
| Violin / Ridgeline / Beeswarm    | Yes                             | No                                                |
| ROC / SHAP / Confusion Matrix    | Yes (native)                    | No (Python visual only)                           |
| Decision tree                    | Yes                             | Via custom visual                                 |
| Candlestick                      | Yes                             | Via custom visual                                 |
| Bump / Slope / Dumbbell          | Yes                             | No                                                |
| Calendar heatmap                 | Yes                             | Via custom visual                                 |
| Marimekko / Parallel coords      | Yes                             | Via custom visual                                 |
| Scatter3D / Surface3D            | Yes                             | Python visual                                     |

**Comparable chart breadth — different strengths.** Hermetic wins on specialized analytical charts (ML, 3D, geographic, financial). Power BI wins on enterprise-specific visuals (decomposition tree, key influencers, smart narrative, AppSource marketplace, write-back via translytical task flows).

---

## Interactive Features

| Feature                    | Hermetic                                               | Power BI                                                      |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Cross-filtering            | Yes (DataController, sub-second client-side)           | Yes (native, between any visuals)                             |
| Drill-down / drill-through | Yes (AI re-analysis with filtered context)             | Yes (native hierarchy drill, drill-through pages)             |
| Slicers / Filters          | Yes (SelectControl, NumberInput, ToggleSwitch)         | Yes (button, list, dropdown, range, hierarchy, sync slicers)  |
| Bookmarks                  | No                                                     | Yes (filter-state snapshots)                                  |
| What-if parameters         | Yes (NumberInput + reactive state + compute pipelines) | Yes (What-if parameter sliders)                               |
| Conditional formatting     | Tables only                                            | Yes (extensive, rule-based)                                   |
| Tooltips                   | Yes                                                    | Yes (incl. report-page tooltips)                              |
| Dynamic measure switching  | No                                                     | Yes (Field parameters)                                        |
| Visual calculations        | No                                                     | Yes (DAX scoped to a single visual)                           |
| Report pages / tabs        | Yes (LayoutGrid + SectionBreak; AI-composed)           | Yes (multi-page reports)                                      |
| Mobile layout              | Responsive only                                        | Yes (phone layout designer + native iOS/Android/Windows apps) |
| Persistent filters         | No                                                     | Yes                                                           |
| Personalized visuals       | No                                                     | Yes                                                           |
| Analyze in Excel           | XLSX export                                            | Yes (live model, native)                                      |

**Power BI wins on interactive sophistication** — decades of BI feature development. **Hermetic's interactivity is AI-generated**, requiring no manual configuration.

---

## Collaboration & Sharing

| Feature                              | Hermetic | Power BI                                                                             |
| ------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| Shared workspaces                    | No       | Yes (Pro / PPU / Premium / Fabric F-SKU)                                             |
| Real-time co-editing                 | No       | Yes (in Power BI Service)                                                            |
| Comments                             | No       | Yes                                                                                  |
| Row-level security (RLS)             | No       | Yes (incl. with Direct Lake)                                                         |
| Object-level security (OLS)          | No       | Yes                                                                                  |
| Sensitivity labels                   | No       | Yes (Microsoft Purview Information Protection — persists on export to Excel/PDF/PPT) |
| Sharing links                        | No       | Yes (with permissions)                                                               |
| Power BI Apps (curated distribution) | No       | Yes (audience-targeted apps)                                                         |
| Publish to web                       | No       | Yes                                                                                  |
| Embedded analytics                   | No       | Yes (App-owns-data + User-owns-data on F SKU)                                        |
| Teams integration                    | No       | Yes (native)                                                                         |
| Microsoft 365 Copilot                | No       | Yes (semantic models surface in M365 Copilot)                                        |
| Email subscriptions                  | No       | Yes                                                                                  |
| Paginated reports (.rdl)             | No       | Yes (pixel-perfect, scheduled; Premium / F-SKU)                                      |
| Deployment pipelines                 | No       | Yes (Dev/Test/Prod for content + data agents)                                        |
| Git integration                      | No       | Yes (full Fabric workspace Git)                                                      |
| API access                           | No       | Yes (extensive REST API + Fabric APIs)                                               |
| Mobile app                           | No       | Yes (iOS, Android, Windows, responsive)                                              |

**Power BI wins on enterprise collaboration.** It's a full enterprise BI platform with governance, security, and distribution built in.

---

## Export

| Feature                    | Hermetic                    | Power BI                                                   |
| -------------------------- | --------------------------- | ---------------------------------------------------------- |
| PDF                        | Yes (themed, multi-page A4) | Yes                                                        |
| DOCX                       | **Yes (landscape)**         | No                                                         |
| PPTX                       | Yes                         | Yes (export to PowerPoint with **live, refreshing tiles**) |
| PNG                        | Yes (2× pixel ratio)        | Yes                                                        |
| CSV                        | Yes                         | Yes                                                        |
| XLSX (multi-sheet, styled) | Yes                         | Yes (Analyze in Excel — live model)                        |
| Paginated report (PDF)     | No                          | Yes (pixel-perfect, scheduled; Premium / F-SKU)            |
| Live PowerPoint            | No                          | Yes (embedded live tiles update automatically)             |
| Email delivery             | No                          | Yes (subscriptions, with sensitivity labels honored)       |

**Notable Power BI exclusive**: Live PowerPoint tiles + Analyze in Excel against a live semantic model. **Hermetic exclusive**: DOCX export, multi-sheet styled XLSX from any analysis.

---

## Deployment & Privacy

| Feature                 | Hermetic                         | Power BI                                                        |
| ----------------------- | -------------------------------- | --------------------------------------------------------------- |
| Self-hosted             | Yes (fully)                      | Partial (Power BI Report Server — **no Copilot**)               |
| Cloud                   | No (local-first)                 | Yes (Power BI Service / Fabric)                                 |
| Fully offline           | Yes (Docker + local LLM)         | No (Copilot requires cloud Fabric capacity)                     |
| Open source             | Yes (MIT)                        | No                                                              |
| Data stays on-premise   | Yes (always)                     | Possible (DirectQuery / Report Server) but Copilot loses access |
| LLM never sees row data | **Yes (schema-only context)**    | No (Copilot reasons over semantic model + data)                 |
| BYO LLM                 | Yes (any of 7 providers + local) | No (Azure OpenAI only)                                          |
| Copilot works on-prem?  | N/A                              | **No (Power BI Report Server still excluded in 2026)**          |
| Sovereign-cloud Copilot | N/A                              | No (sovereign clouds not supported by Copilot)                  |
| FedRAMP                 | N/A                              | Yes (Power BI for US Government / GCC High — FedRAMP High)      |
| SOC 1 / SOC 2 / SOC 3   | N/A (self-hosted)                | Yes                                                             |
| HIPAA                   | N/A (self-hosted)                | Yes (BAA available)                                             |
| GDPR                    | N/A (self-hosted)                | Yes (EU Data Boundary support)                                  |
| Customer-managed keys   | N/A                              | Yes (BYOK on Premium / F-SKU)                                   |

**Critical gap for Power BI**: Copilot still **does not work on Power BI Report Server** in 2026, and is unsupported in sovereign clouds. If you deploy on-prem for data privacy or run in GCC/Government Cloud (without F-SKU+), you lose all AI capabilities. **Hermetic's AI works fully offline** with local LLMs.

---

## Pricing Comparison (April 2026)

|                       | Hermetic | PBI Free  | PBI Pro                          | PBI PPU                 | Fabric F2 (smallest)               | Fabric F64 (P1 equiv)          |
| --------------------- | -------- | --------- | -------------------------------- | ----------------------- | ---------------------------------- | ------------------------------ |
| **Price**             | Free     | $0        | $14/user/mo                      | $24/user/mo             | ~$263/mo (PAYG)                    | ~$8,410/mo (PAYG)              |
| Copilot               | Included | No        | No (per-user alone insufficient) | No (alone insufficient) | **Yes (lowered from F64 in 2025)** | Yes                            |
| Fabric Data Agents    | N/A      | No        | No                               | No                      | Yes (with capacity)                | Yes                            |
| Free-licensed viewers | N/A      | View only | N/A                              | N/A                     | No                                 | **Yes (F64 viewer threshold)** |
| Sharing               | N/A      | View only | Yes                              | Yes                     | Capacity-bound                     | Capacity-bound                 |
| Paginated reports     | No       | No        | No                               | Yes                     | Yes                                | Yes                            |
| Deployment pipelines  | No       | No        | No                               | No                      | Yes (capacity)                     | Yes                            |
| Embedded analytics    | No       | No        | No                               | No                      | Yes (any F SKU)                    | Yes                            |
| Direct Lake           | N/A      | No        | No                               | No                      | Yes                                | Yes                            |
| BYO LLM               | Yes      | N/A       | N/A                              | N/A                     | No                                 | No                             |

**Big 2025–2026 change**: Microsoft lowered the Copilot capacity floor from F64 to **F2 (~$263/month)** in April 2025. Reserved-instance pricing cuts ~41%. Existing Power BI Premium **P SKUs are being retired for new customers** — new purchases are channeled to Fabric F SKUs.

**The real cost of Power BI + Copilot for a 10-user team**: 10 × Pro ($14) = $140/mo, plus an F2 capacity for Copilot ≈ $263/mo = **~$403/month minimum**. Larger orgs scale to F64+ for free-tier viewers and bigger workloads. Hermetic: $0.

---

## Semantic Model vs Schema Detection

This is a fundamental architectural difference:

|                  | Hermetic                                          | Power BI                                                                                                    |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Data modeling    | None required (auto-detected schema + statistics) | Semantic model required (relationships, measures, hierarchies, calculation groups, perspectives)            |
| Setup time       | Seconds (upload / connect, then ask)              | Hours to days (model, relationships, DAX measures, calculation groups, RLS)                                 |
| Accuracy of AI   | Depends on LLM quality + schema metadata          | Higher (semantic model + RLS constrain Copilot, "verified answers" possible)                                |
| Flexibility      | Any question, any data                            | Questions constrained by model design                                                                       |
| Maintenance      | None                                              | Ongoing model maintenance + Copilot enablement (synonyms, descriptions)                                     |
| Cross-tool reuse | Specs portable as JSON                            | Semantic models reused via XMLA, M365 Copilot, Tableau, Excel, Fabric notebooks (via Semantic Link / SemPy) |

**Power BI's semantic model + Fabric Data Agents make Copilot more accurate and policy-aware** — but require significant upfront investment. **Hermetic's zero-setup approach is faster** but may produce less precise results on complex enterprise data without a curated model behind it.

---

## What's New Since the Previous Version of This Comparison

**Power BI / Fabric (since March 2026):**

- **Copilot capacity floor lowered to F2** (~$263/mo) — was F64 (~$8,400/mo). Massive accessibility upgrade.
- **Standalone Copilot** (preview) — full-screen, cross-item AI chat that spans reports, semantic models, and Fabric Data Agents.
- **App-scoped Copilot** (preview) — Copilot constrained to a curated Power BI app with author-verified answers.
- **Fabric Data Agents GA** — read-only, RLS-aware, multi-source (up to 5: lakehouses, warehouses, KQL, semantic models, Microsoft Graph). Surface in M365 Copilot, Copilot Studio, Azure AI Foundry, and Teams.
- **Q&A visual deprecation** announced for **December 2026** — Copilot/Data Agents replace it.
- **Power BI Premium P SKUs being retired** for new customers — Fabric F SKUs are the path forward.
- **Visual calculations** GA (DAX scoped to a single visual).
- **Translytical task flows** GA (write-back from a visual).
- **Direct Lake** sub-second query mode over OneLake Parquet/Delta without import.
- **Semantic Link / SemPy** — Python library exposing Power BI semantic models inside Fabric notebooks, so data scientists can use governed measures in ML.
- **Git integration for all Fabric items** + deployment pipelines for data agents.
- **AI Auto-Summary for semantic models** (preview).
- **Per-user prices ticked up** — Pro from $10 to $14, PPU from $20 to $24.

**Hermetic (since March 2026):**

- **Parquet & DuckDB support** with Hive-partitioned folder detection. DuckDB always available in the sandbox alongside pandas; statistical schema computed via DuckDB SQL.
- **Local file browser with bind-mount execution** — read-only mount of any host file or folder into the sandbox, no copy.
- **Persistent analysis history** with replay/restore/delete. Restore button rehydrates a saved viz without a fresh LLM call.
- **Server-side conversation cache** for follow-up questions (5 turns, 30-min TTL).
- **Globe arc filtering** for origin-destination flow visualizations.
- **300-second sandbox timeout** for large Parquet workloads (was 120s).
- **Saved warehouse connections as one-click pills** on the home screen.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **dashboard in seconds** from a single question, no setup
- **Data privacy is non-negotiable** (Copilot doesn't work on Report Server, doesn't work in sovereign clouds, and reasons over your data when it runs)
- You want the **LLM to never see your data** (schema-only context)
- You're **not in the Microsoft ecosystem** or don't want Fabric capacity costs
- You want to **choose your LLM** (not locked to Azure OpenAI)
- You need **specialized charts** (3D, geographic, ML, financial, calendar) out of the box
- You want **zero cost** with no licensing complexity
- You need **DOCX export**, multi-sheet styled XLSX, or **offline operation**
- You need **Parquet / DuckDB for big-local data** without a Fabric capacity

### Choose Power BI / Fabric when:

- You're an **enterprise in the Microsoft ecosystem** (M365, Teams, SharePoint, Purview)
- You need a **semantic model** for governed, consistent metrics across the org with RLS/OLS
- You need **150+ data connectors** including Salesforce, SAP, Dynamics, Workday, OneLake
- You need **enterprise collaboration** (workspaces, sensitivity labels, deployment pipelines, Git)
- You need **embedded analytics** in your own products (Power BI Embedded)
- You need **scheduled paginated reports** and email/Teams delivery with Purview policies
- You need **compliance** (FedRAMP High, SOC 1/2/3, HIPAA, GDPR, EU Data Boundary, BYOK)
- You want **agentic AI** that respects RLS and Microsoft Purview policies (Fabric Data Agents)
- You have budget for **at least an F2 Fabric capacity** to unlock Copilot, or larger SKUs for free-tier viewers

### The Fundamental Difference

**Hermetic** is an **AI-native tool** built from the ground up for generative dashboards. No data model, no setup, no licensing — ask a question, get an answer. The LLM never sees a single row of data.

**Power BI + Fabric** is a **mature enterprise BI and data platform** with Copilot and Fabric Data Agents added on top. The AI is now genuinely powerful (multi-source agents, RLS-aware, Purview-governed, MCP-friendly) but it lives inside an ecosystem that requires semantic models, Fabric capacity, Microsoft licensing, and a cloud connection. The AI cannot work without the platform underneath it.

Hermetic is the camera phone. Power BI is the DSLR with a brilliant new autofocus system. One is instant and accessible; the other is more powerful but requires expertise, infrastructure, and investment.

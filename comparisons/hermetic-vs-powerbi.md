# Hermetic vs Power BI Copilot — Competitive Feature Comparison

_Last updated: 2026-03-24_

## Overview

| Category        | Hermetic                                 | Power BI (with Copilot)                                                     |
| --------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| **Core Model**  | AI-first: question to complete dashboard | BI platform + AI assistant (Copilot generates report pages)                 |
| **Deployment**  | Self-hosted / local-first                | Cloud (Power BI Service) + Desktop app + On-prem (Report Server)            |
| **Pricing**     | Free (open source)                       | Pro $10/user/mo, Premium $20/user/mo. Copilot requires Fabric F64+ capacity |
| **Ecosystem**   | Standalone                               | Microsoft 365 / Fabric ecosystem                                            |
| **Target User** | Solo analyst, privacy-first              | Enterprise, Microsoft-stack organizations                                   |

---

## AI / Copilot Capabilities

| Feature                  | Hermetic                       | Power BI Copilot                                                |
| ------------------------ | ------------------------------ | --------------------------------------------------------------- |
| NL to complete dashboard | Yes (one prompt, multi-widget) | Yes (can generate entire report pages from prompts, as of 2025) |
| NL to individual chart   | Yes (part of dashboard)        | Yes (create visual from description)                            |
| NL to narrative summary  | Yes (TextBlock components)     | Yes (Smart Narrative visual, Copilot summaries)                 |
| NL Q&A                   | Yes (primary UX)               | Yes (Q&A visual, natural language queries)                      |
| NL to DAX/measures       | No (generates Python instead)  | Yes (Copilot generates DAX formulas)                            |
| Report page generation   | AI generates full layout       | Copilot generates report pages with suggested visuals           |
| Report modification      | Follow-up questions            | Copilot can modify existing reports conversationally            |
| Explain data             | No                             | Yes (explain increase/decrease in metrics)                      |
| Suggested questions      | No                             | Yes (Copilot suggests follow-up questions)                      |
| Multi-provider LLM       | Yes (7 providers + local)      | No (Azure OpenAI only)                                          |
| Local/offline LLM        | Yes                            | No (requires cloud connectivity)                                |
| Output style control     | Yes (6 styles)                 | No (standard report format)                                     |
| Schema-aware             | Yes (auto-detected)            | Yes (semantic model aware)                                      |
| Drill-down re-analysis   | Yes (AI re-analyzes segment)   | Native drill-down (within existing report)                      |

**Power BI Copilot is the closest traditional BI tool to Hermetic's generative approach** — it can now generate entire report pages from NL prompts. **Hermetic wins on LLM flexibility** (7 providers, local models) and **output style variety** (6 styles). **Power BI wins on data modeling intelligence** (semantic model, DAX generation, explain features).

---

## Data Sources

| Feature             | Hermetic                         | Power BI                     |
| ------------------- | -------------------------------- | ---------------------------- |
| CSV upload          | Yes (100MB)                      | Yes                          |
| Excel               | Yes (multi-sheet + FK detection) | Yes (deep Excel integration) |
| GeoJSON native      | Yes                              | Via shape maps or ArcGIS     |
| PostgreSQL          | Yes                              | Yes                          |
| BigQuery            | Yes                              | Yes                          |
| ClickHouse          | Yes                              | Via ODBC                     |
| Trino               | Yes                              | Via ODBC                     |
| Hive                | Yes                              | Yes                          |
| Snowflake           | No                               | Yes                          |
| Databricks          | No                               | Yes                          |
| Redshift            | No                               | Yes                          |
| Azure SQL / Synapse | No                               | Yes (native, optimized)      |
| SQL Server          | No                               | Yes (native)                 |
| Oracle              | No                               | Yes                          |
| MySQL               | No                               | Yes                          |
| SharePoint          | No                               | Yes                          |
| Dynamics 365        | No                               | Yes                          |
| Salesforce          | No                               | Yes                          |
| SAP                 | No                               | Yes                          |
| Web / OData / REST  | No                               | Yes                          |
| Dataverse           | No                               | Yes (native)                 |
| OneLake / Fabric    | No                               | Yes (native)                 |
| Total connectors    | 5 warehouse + files              | 100+                         |

**Power BI wins overwhelmingly on connectors** — 100+ via the Microsoft ecosystem. **Hermetic wins on simplicity** — no data modeling required, just connect and ask.

---

## Visualization

| Feature                       | Hermetic            | Power BI                                  |
| ----------------------------- | ------------------- | ----------------------------------------- |
| Native chart types            | 42+ (AI-selected)   | ~30 built-in + custom visuals marketplace |
| Bar / Column                  | Yes                 | Yes                                       |
| Line / Area                   | Yes                 | Yes                                       |
| Pie / Donut                   | Yes                 | Yes                                       |
| Scatter                       | Yes                 | Yes                                       |
| Table / Matrix                | Yes                 | Yes (Matrix with drill)                   |
| KPI / Card                    | Yes (StatCard)      | Yes (Card, Multi-row Card, KPI)           |
| Gauge                         | No                  | Yes                                       |
| Funnel                        | No                  | Yes                                       |
| Waterfall                     | Yes                 | Yes                                       |
| Treemap                       | Yes                 | Yes                                       |
| Map (basic)                   | Yes (MapLibre)      | Yes (Bing Maps, ArcGIS)                   |
| Map (choropleth)              | Yes                 | Yes (Shape Map, Filled Map)               |
| Decomposition tree            | No                  | Yes (AI-powered)                          |
| Key influencers               | No                  | Yes (AI-powered)                          |
| Q&A visual                    | No                  | Yes                                       |
| Ribbon chart                  | No                  | Yes                                       |
| R/Python visuals              | Via sandbox         | Yes (in-report)                           |
| Custom visuals                | No                  | Yes (AppSource marketplace, 300+)         |
| **Hermetic-exclusive**        |                     |                                           |
| 3D Globe                      | Yes                 | No                                        |
| Deck.gl 3D maps               | Yes (5 layer types) | No                                        |
| Sankey / Chord                | Yes (native)        | Via custom visuals                        |
| Violin / Ridgeline / Beeswarm | Yes                 | No                                        |
| ROC / SHAP / Confusion Matrix | Yes (native)        | No                                        |
| Candlestick                   | Yes                 | Via custom visual                         |
| Bump / Slope / Dumbbell       | Yes                 | No                                        |
| Calendar heatmap              | Yes                 | Via custom visual                         |
| **Power BI-exclusive**        |                     |                                           |
| Decomposition tree            | No                  | Yes                                       |
| Key influencers               | No                  | Yes                                       |
| Smart Narrative               | No                  | Yes                                       |
| Paginated reports             | No                  | Yes                                       |
| Sparklines in tables          | No                  | Yes                                       |

**Comparable chart breadth** — different strengths. Hermetic excels at specialized analytical charts (ML, 3D, geographic). Power BI excels at enterprise visuals (decomposition tree, key influencers) and has a marketplace of 300+ custom visuals.

---

## Interactive Features

| Feature                    | Hermetic                           | Power BI                                          |
| -------------------------- | ---------------------------------- | ------------------------------------------------- |
| Cross-filtering            | Yes (DataController)               | Yes (native, between any visuals)                 |
| Drill-down / drill-through | Yes (AI re-analysis)               | Yes (native hierarchy drill, drill-through pages) |
| Slicers / Filters          | Yes (SelectControl)                | Yes (comprehensive slicer system)                 |
| Bookmarks                  | No                                 | Yes (save and switch between filter states)       |
| What-if parameters         | Yes (NumberInput + reactive state) | Yes (What-if parameter sliders)                   |
| Conditional formatting     | Tables only                        | Yes (extensive, rule-based)                       |
| Tooltips                   | Yes                                | Yes (custom tooltip pages)                        |
| Dynamic measure switching  | No                                 | Yes (field parameters)                            |
| Report pages / tabs        | No (single dashboard)              | Yes (multi-page reports)                          |
| Mobile layout              | No                                 | Yes (phone layout designer)                       |

**Power BI wins on interactive sophistication** — decades of BI feature development. **Hermetic's interactivity is AI-generated**, requiring no manual configuration.

---

## Collaboration & Sharing

| Feature              | Hermetic | Power BI                               |
| -------------------- | -------- | -------------------------------------- |
| Shared workspaces    | No       | Yes                                    |
| Real-time co-editing | No       | Yes (in Power BI Service)              |
| Comments             | No       | Yes                                    |
| Row-level security   | No       | Yes                                    |
| Sensitivity labels   | No       | Yes (Microsoft Information Protection) |
| Sharing links        | No       | Yes (with permissions)                 |
| Publish to web       | No       | Yes                                    |
| Embedded analytics   | No       | Yes (Power BI Embedded, comprehensive) |
| Teams integration    | No       | Yes (native)                           |
| Email subscriptions  | No       | Yes                                    |
| Paginated reports    | No       | Yes (pixel-perfect, scheduled)         |
| Deployment pipelines | No       | Yes (dev/test/prod)                    |
| API access           | No       | Yes (REST API, extensive)              |
| Mobile app           | No       | Yes (iOS, Android, responsive)         |

**Power BI wins on enterprise collaboration.** It's a full enterprise BI platform with governance, security, and distribution built in.

---

## Export

| Feature                | Hermetic     | Power BI                                  |
| ---------------------- | ------------ | ----------------------------------------- |
| PDF                    | Yes (themed) | Yes                                       |
| DOCX                   | Yes          | No                                        |
| PPTX                   | Yes          | Yes (export to PowerPoint with live data) |
| PNG                    | Yes (2x)     | Yes                                       |
| CSV                    | Yes          | Yes                                       |
| XLSX (multi-sheet)     | Yes          | Yes                                       |
| Paginated report (PDF) | No           | Yes (pixel-perfect, scheduled)            |
| Live PowerPoint        | No           | Yes (embedded live tiles in PPTX)         |
| Email delivery         | No           | Yes (subscriptions)                       |

**Notable Power BI exclusive**: Live PowerPoint integration — embed live, interactive Power BI tiles in presentations that update automatically. **Hermetic exclusive**: DOCX export.

---

## Deployment & Privacy

| Feature                | Hermetic                 | Power BI                                      |
| ---------------------- | ------------------------ | --------------------------------------------- |
| Self-hosted            | Yes (fully)              | Partial (Power BI Report Server — no Copilot) |
| Cloud                  | No (local-first)         | Yes (Power BI Service)                        |
| Fully offline          | Yes (Docker + local LLM) | No (Copilot requires cloud)                   |
| Open source            | Yes                      | No                                            |
| Data stays on-premise  | Yes (always)             | Possible (Direct Query / Report Server)       |
| Copilot works on-prem? | N/A                      | No (requires Fabric F64+ capacity in cloud)   |
| FedRAMP                | N/A                      | Yes                                           |
| SOC 2                  | N/A (self-hosted)        | Yes                                           |
| HIPAA                  | N/A (self-hosted)        | Yes                                           |
| GDPR                   | N/A (self-hosted)        | Yes                                           |

**Critical gap for Power BI**: Copilot (the AI features) **do not work on-premises**. If you deploy Power BI Report Server for data privacy, you lose all AI capabilities. **Hermetic's AI works fully offline** with local LLMs.

---

## Pricing Comparison

|                      | Hermetic | PBI Free  | PBI Pro     | PBI Premium/User     | PBI Premium/Capacity |
| -------------------- | -------- | --------- | ----------- | -------------------- | -------------------- |
| **Price**            | Free     | $0        | $10/user/mo | $20/user/mo          | $4,995/mo (P1)       |
| Copilot AI           | Included | No        | No          | Requires Fabric F64+ | Requires Fabric F64+ |
| Sharing              | N/A      | View only | Yes         | Yes                  | Yes                  |
| Paginated reports    | No       | No        | No          | Yes                  | Yes                  |
| Deployment pipelines | No       | No        | No          | No                   | Yes                  |
| Dataflows            | No       | No        | Yes         | Yes                  | Yes                  |
| Embedded             | No       | No        | No          | No                   | Yes                  |

**The real cost of Power BI + Copilot**: Pro license ($10/user/mo) + Fabric F64 capacity (~$5,000+/mo) = minimum ~$5,100/month to use Copilot for a team. Hermetic: $0.

---

## Semantic Model vs Schema Detection

This is a fundamental architectural difference:

|                | Hermetic                             | Power BI                                                       |
| -------------- | ------------------------------------ | -------------------------------------------------------------- |
| Data modeling  | None required (auto-detected schema) | Semantic model required (relationships, measures, hierarchies) |
| Setup time     | Seconds (upload + ask)               | Hours to days (model, relationships, DAX measures)             |
| Accuracy of AI | Depends on LLM quality               | Higher (semantic model constrains AI)                          |
| Flexibility    | Any question, any data               | Questions constrained by model design                          |
| Maintenance    | None                                 | Ongoing model maintenance                                      |

**Power BI's semantic model makes Copilot more accurate** but requires significant upfront investment. **Hermetic's zero-setup approach is faster** but may produce less precise results on complex data.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **dashboard in seconds** from a single question, no setup
- **Data privacy is non-negotiable** (Copilot doesn't work on-prem)
- You're **not in the Microsoft ecosystem**
- You want to **choose your LLM** (not locked to Azure OpenAI)
- You need **specialized charts** (3D, geographic, ML, financial) out of the box
- You want **zero cost** with no licensing complexity
- You need **DOCX export** or **offline operation**

### Choose Power BI when:

- You're an **enterprise in the Microsoft ecosystem** (M365, Teams, SharePoint)
- You need a **semantic model** for governed, consistent metrics across the org
- You need **100+ data connectors**
- You need **enterprise collaboration** (RBAC, RLS, deployment pipelines)
- You need **embedded analytics** in your own products
- You need **scheduled reports** and email/Teams delivery
- You need **compliance** (FedRAMP, SOC2, HIPAA, GDPR)
- You have budget for **Fabric F64+ capacity** to unlock Copilot

### The Fundamental Difference

**Hermetic** is an **AI-native tool** built from the ground up for generative dashboards. No data model, no setup, no licensing — ask a question, get an answer.

**Power BI** is a **mature enterprise BI platform** that added AI (Copilot) as a layer on top. The AI is powerful but requires significant infrastructure: semantic models, Fabric capacity, Microsoft licensing. The AI can't work without the platform underneath it.

Hermetic is the camera phone. Power BI is the DSLR with a new autofocus system. One is instant and accessible; the other is more powerful but requires expertise and investment.

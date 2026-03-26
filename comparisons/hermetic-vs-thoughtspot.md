# Hermetic vs ThoughtSpot — Competitive Feature Comparison

_Last updated: 2026-03-24_

## Overview

| Category        | Hermetic                                 | ThoughtSpot                                                                  |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| **Core Model**  | AI-first: question to complete dashboard | Search-first: type a query, get auto-chart                                   |
| **Deployment**  | Self-hosted / local-first                | Cloud (ThoughtSpot Cloud) or self-hosted (ThoughtSpot Software)              |
| **Pricing**     | Open source (free)                       | Essentials ~$25/user/mo, Pro ~$50/user/mo, Enterprise custom (~$137K/yr avg) |
| **Target User** | Solo analyst, privacy-sensitive orgs     | Enterprise data teams, business users                                        |
| **Acquisition** | N/A                                      | Acquired Mode Analytics for $200M (2024)                                     |

---

## Data Sources

| Feature            | Hermetic                                   | ThoughtSpot                    |
| ------------------ | ------------------------------------------ | ------------------------------ |
| CSV upload         | Yes (100MB)                                | Yes (via Mode or admin upload) |
| Excel upload       | Yes (multi-sheet + relationship detection) | Limited                        |
| GeoJSON native     | Yes                                        | No                             |
| PostgreSQL         | Yes                                        | Yes                            |
| BigQuery           | Yes                                        | Yes                            |
| ClickHouse         | Yes                                        | No                             |
| Trino              | Yes                                        | Yes (via Starburst)            |
| Hive               | Yes                                        | Yes                            |
| Snowflake          | No                                         | Yes (primary connector)        |
| Databricks         | No                                         | Yes (primary connector)        |
| Redshift           | No                                         | Yes                            |
| Azure Synapse      | No                                         | Yes                            |
| Oracle             | No                                         | Yes                            |
| SQL Server         | No                                         | Yes                            |
| Teradata           | No                                         | Yes                            |
| SAP HANA           | No                                         | Yes                            |
| Google Sheets      | No                                         | Yes (via Mode)                 |
| dbt integration    | No                                         | Yes (via Mode)                 |
| Custom JDBC        | No                                         | Yes                            |
| Mode SQL notebooks | No                                         | Yes (included via acquisition) |

**ThoughtSpot wins decisively on enterprise data source breadth** (20+ native connectors). **Hermetic wins on file-based intelligence** (auto-relationship detection, GeoJSON native) and local-first data handling.

---

## AI / NL Capabilities

| Feature                  | Hermetic                               | ThoughtSpot                                           |
| ------------------------ | -------------------------------------- | ----------------------------------------------------- |
| NL to complete dashboard | Yes (one prompt, multi-widget)         | Partial (search to single chart, pin to Liveboard)    |
| NL to SQL                | Yes (via LLM)                          | Yes (via ThoughtSpot Sage / LLM)                      |
| Search-driven analytics  | No (question-based)                    | Yes (type-ahead search bar is core UX)                |
| AI-generated insights    | No                                     | Yes (SpotIQ: auto-anomaly detection, trend analysis)  |
| Proactive alerts         | No                                     | Yes (Monitor: threshold-based alerts via email/Slack) |
| Schema-aware generation  | Yes                                    | Yes (models the semantic layer)                       |
| Multi-provider LLM       | Yes (7 providers)                      | No (ThoughtSpot's own AI)                             |
| Local/offline LLM        | Yes (MLX, llama.cpp, Ollama)           | No                                                    |
| Output style control     | Yes (6 styles)                         | No (single search-result format)                      |
| Drill-down re-analysis   | Yes (click chart, get new AI analysis) | Yes (drill-down within Liveboards)                    |
| Follow-up questions      | Yes (conversation context)             | Yes (search refinement)                               |
| AI Explain               | No                                     | Yes (SpotIQ explains anomalies in plain English)      |

**ThoughtSpot wins on proactive AI** — SpotIQ automatically finds anomalies and trends without being asked. **Hermetic wins on generative composition** — produces complete multi-widget dashboards from a single question, not just individual charts.

---

## Visualization

| Feature                                 | Hermetic                            | ThoughtSpot             |
| --------------------------------------- | ----------------------------------- | ----------------------- |
| Native chart types                      | 42+ (AI-selected)                   | ~15 built-in            |
| Bar (grouped, stacked)                  | Yes                                 | Yes                     |
| Line / Area                             | Yes                                 | Yes                     |
| Pie / Donut                             | Yes                                 | Yes                     |
| Scatter                                 | Yes                                 | Yes                     |
| Table / Pivot                           | DataTable                           | Yes (with pivot)        |
| KPI / Headline                          | StatCard + TrendIndicator           | Yes (Headline viz)      |
| Heatmap                                 | Yes                                 | Yes                     |
| Treemap                                 | Yes                                 | Yes                     |
| Geo map                                 | Yes (MapView, Globe3D, Map3D)       | Yes (basic geo)         |
| Sankey                                  | Yes                                 | No                      |
| Chord diagram                           | Yes                                 | No                      |
| Violin / Ridgeline                      | Yes                                 | No                      |
| Candlestick                             | Yes                                 | No                      |
| 3D charts                               | Yes (Scatter3D, Surface3D, Globe3D) | No                      |
| Deck.gl maps                            | Yes (5 layer types)                 | No                      |
| ML charts (ROC, SHAP, confusion matrix) | Yes                                 | No                      |
| Decision tree                           | Yes                                 | No                      |
| Waterfall / Bullet / Bump               | Yes                                 | No                      |
| Calendar heatmap                        | Yes                                 | No                      |
| Custom Python charts                    | Yes (sandbox)                       | Yes (via Mode R/Python) |

**Hermetic wins on chart diversity** (42+ native types). **ThoughtSpot wins on chart simplicity** — fewer types but optimized for search-driven exploration with automatic axis/aggregation selection.

---

## Interactive Features

| Feature                 | Hermetic                  | ThoughtSpot                            |
| ----------------------- | ------------------------- | -------------------------------------- |
| Search bar (core UX)    | No (question box)         | Yes (type-ahead search is the product) |
| Drill-down              | Yes (AI re-analysis)      | Yes (native drill, drill anywhere)     |
| Cross-filtering         | Yes (DataController)      | Yes (native)                           |
| Dynamic filters         | Yes (SelectControl)       | Yes (runtime filters)                  |
| Liveboards (dashboards) | AI-generated per question | Yes (persistent, pinned answers)       |
| Scheduled reports       | No                        | Yes (email, Slack)                     |
| Alerts / Monitoring     | No                        | Yes (threshold-based monitors)         |
| Mobile app              | No                        | Yes (iOS, Android)                     |

**ThoughtSpot wins on enterprise interactivity** — persistent Liveboards, scheduled reports, mobile app, monitoring. **Hermetic wins on zero-effort creation** — no need to build or pin anything.

---

## Collaboration & Sharing

| Feature                | Hermetic | ThoughtSpot                       |
| ---------------------- | -------- | --------------------------------- |
| Sharing links          | No       | Yes (with permissions)            |
| User roles / RBAC      | No       | Yes (Admin, Author, Viewer, etc.) |
| Row-level security     | No       | Yes                               |
| Group management       | No       | Yes                               |
| Comments / annotations | No       | Yes (on Liveboards)               |
| Scheduled delivery     | No       | Yes (email PDFs, Slack)           |
| Embedded analytics     | No       | Yes (ThoughtSpot Everywhere)      |
| White-label embedding  | No       | Yes                               |
| API access             | No       | Yes (REST, SDK, GraphQL)          |
| SSO / SAML             | No       | Yes                               |
| Audit logs             | No       | Yes                               |

**ThoughtSpot wins on enterprise collaboration and governance.** Hermetic is single-user.

---

## Export

| Feature            | Hermetic                 | ThoughtSpot |
| ------------------ | ------------------------ | ----------- |
| PDF                | Yes (themed, multi-page) | Yes         |
| DOCX               | Yes                      | No          |
| PPTX               | Yes                      | No          |
| PNG                | Yes (2x)                 | Yes         |
| CSV                | Yes                      | Yes         |
| XLSX (multi-sheet) | Yes                      | Yes         |
| Scheduled email    | No                       | Yes         |
| Slack delivery     | No                       | Yes         |
| API export         | No                       | Yes         |

**Hermetic wins on document formats** (DOCX, PPTX). **ThoughtSpot wins on automated delivery.**

---

## Deployment & Privacy

| Feature                    | Hermetic                 | ThoughtSpot                |
| -------------------------- | ------------------------ | -------------------------- |
| Self-hosted                | Yes (fully)              | Yes (ThoughtSpot Software) |
| Cloud                      | No (local-first)         | Yes (ThoughtSpot Cloud)    |
| Fully offline / air-gapped | Yes (Docker + local LLM) | Possible (on-prem)         |
| Open source                | Yes                      | No                         |
| Data stays on-premise      | Yes (always)             | Yes (on-prem option)       |
| FedRAMP                    | No                       | Yes (Government Cloud)     |
| SOC 2                      | N/A (self-hosted)        | Yes                        |
| HIPAA                      | N/A (self-hosted)        | Yes                        |

**Both can be self-hosted.** Hermetic is free and open source. ThoughtSpot self-hosted requires enterprise licensing.

---

## Pricing Comparison

|                 | Hermetic     | ThoughtSpot Essentials | ThoughtSpot Pro | ThoughtSpot Enterprise |
| --------------- | ------------ | ---------------------- | --------------- | ---------------------- |
| **Price**       | Free (OSS)   | ~$25/user/mo           | ~$50/user/mo    | Custom (~$137K/yr avg) |
| AI search       | Included     | Yes                    | Yes             | Yes                    |
| SpotIQ insights | N/A          | Limited                | Yes             | Yes                    |
| Liveboards      | AI-generated | Yes                    | Yes             | Yes                    |
| Monitors/Alerts | No           | No                     | Yes             | Yes                    |
| Embedding       | No           | No                     | No              | Yes                    |
| Mode notebooks  | No           | No                     | Yes             | Yes                    |
| SSO / RBAC      | No           | Basic                  | Yes             | Yes                    |
| Self-hosted     | Yes          | No                     | No              | Yes                    |

A team of 20 users on ThoughtSpot Pro costs ~$12,000/year. Hermetic costs $0.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **complete dashboards from a single question** with no manual building
- **Data privacy is non-negotiable** (air-gapped, fully local)
- You need **42+ chart types** including 3D, geographic, ML-specific
- You want **zero cost** and no vendor lock-in
- You're a **solo analyst or small team**
- You want to **choose your own LLM provider** or run locally

### Choose ThoughtSpot when:

- You need **enterprise search-driven analytics** for business users
- You want **proactive AI insights** (SpotIQ anomaly detection, monitors)
- You need **20+ native data warehouse connectors** (Snowflake, Databricks, Redshift)
- You need **embedded analytics** (ThoughtSpot Everywhere)
- You need **governance** (RBAC, row-level security, audit logs, SOC2/HIPAA)
- You need **scheduled reports** and Slack/email delivery
- You have a **large team** that needs collaboration and sharing

### The Fundamental Difference

**Hermetic** generates a complete, multi-widget dashboard from a single question — AI does everything. The user's job is to ask the right question.

**ThoughtSpot** provides a powerful search bar where users explore data iteratively — AI assists discovery but users build Liveboards manually by pinning individual answers.

Hermetic is "give me the answer." ThoughtSpot is "help me search for the answer."

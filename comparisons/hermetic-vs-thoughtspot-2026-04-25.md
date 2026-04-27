# Hermetic vs ThoughtSpot — Competitive Feature Comparison

_Last updated: 2026-04-25_

## Overview

| Category        | Hermetic                                      | ThoughtSpot                                                                                                                  |
| --------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Core Model**  | AI-first: question to multi-widget dashboard  | Agentic analytics platform — Spotter agents (Spotter 3, SpotterModel, SpotterViz, SpotterCode) + Liveboards + Analyst Studio |
| **Deployment**  | Self-hosted / local-first                     | Cloud (ThoughtSpot Cloud) or self-hosted (ThoughtSpot Software, Government Cloud / FedRAMP)                                  |
| **Pricing**     | Open source (free)                            | Pro $50/user/mo (25 Spotter queries/user/mo, 250M rows); Enterprise custom (~$100K–$500K+/yr)                                |
| **Target User** | Solo analyst, privacy-sensitive orgs          | Enterprise data teams + business users; large deployments                                                                    |
| **Acquisition** | N/A                                           | Mode Analytics ($200M, 2023) — fully integrated as Analyst Studio (GA early 2025)                                            |
| **AI Posture**  | LLM never sees the data (schema-only context) | Spotter agents reason over a governed semantic model with full data access                                                   |

---

## Data Sources

| Feature                               | Hermetic                                      | ThoughtSpot                                             |
| ------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| CSV upload                            | Yes (100MB)                                   | Yes (via Analyst Studio or admin upload)                |
| Excel upload                          | Yes (multi-sheet + relationship detection)    | Limited                                                 |
| GeoJSON native                        | Yes                                           | No                                                      |
| Parquet (single + Hive folders)       | **Yes (DuckDB-backed, zero-copy bind-mount)** | Via warehouse / Iceberg                                 |
| Local file browser                    | **Yes (sandbox bind-mount of host fs)**       | No                                                      |
| PostgreSQL                            | Yes                                           | Yes                                                     |
| BigQuery                              | Yes                                           | Yes                                                     |
| ClickHouse                            | Yes                                           | No                                                      |
| Trino / Starburst                     | Yes                                           | Yes                                                     |
| Hive                                  | Yes                                           | Yes                                                     |
| Snowflake                             | No                                            | Yes (primary connector)                                 |
| Databricks (incl. Unity Catalog)      | No                                            | Yes (primary connector)                                 |
| Redshift                              | No                                            | Yes                                                     |
| Azure Synapse                         | No                                            | Yes                                                     |
| Oracle                                | No                                            | Yes                                                     |
| SQL Server                            | No                                            | Yes                                                     |
| Teradata                              | No                                            | Yes                                                     |
| SAP HANA                              | No                                            | Yes                                                     |
| Google Sheets                         | No                                            | Yes (via Analyst Studio)                                |
| dbt integration                       | No                                            | Yes (Analyst Studio + dbt-aware modeling)               |
| Custom JDBC                           | No                                            | Yes                                                     |
| Apache Iceberg                        | No                                            | Yes                                                     |
| Mode SQL/Python/R notebooks           | No                                            | Yes (Analyst Studio — Mode's successor since 2025)      |
| Spreadsheet UI for governed data prep | No                                            | Yes (new in 2026 — agentic data prep alongside Spotter) |

**ThoughtSpot wins decisively on enterprise data source breadth** — 20+ native connectors, Iceberg, dbt, plus the Analyst Studio code-first surface. **Hermetic wins on local + file-format intelligence** — Parquet folders bind-mounted into the sandbox, multi-sheet Excel relationship detection, and GeoJSON without any modeling.

---

## AI / NL Capabilities

| Feature                                    | Hermetic                                                          | ThoughtSpot (April 2026)                                                        |
| ------------------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| NL to complete dashboard                   | Yes (one prompt → multi-widget JSON-Render)                       | **Yes (SpotterViz — turns data into a complete Liveboard automatically)**       |
| NL to SQL                                  | Yes (5 dialects, cross-table JOINs)                               | Yes (via Sage / Spotter)                                                        |
| Search-driven analytics                    | Question box                                                      | Yes (type-ahead search bar is the long-standing core UX)                        |
| AI-generated insights                      | Yes (data-domain detection — financial, time-series, statistical) | Yes (SpotIQ — auto-anomaly detection, trend analysis)                           |
| Proactive alerts / monitoring              | No                                                                | Yes (Monitor — threshold-based alerts via email/Slack)                          |
| Agentic analytics (autonomous)             | No (single-shot)                                                  | **Yes — 100% of platform is agentic in 2026 (Spotter 3 + 3 specialist agents)** |
| Agent: semantic modeling                   | No                                                                | **SpotterModel** — proposes tables, joins, logic from NL                        |
| Agent: dashboard generation                | The whole product                                                 | **SpotterViz** — generates a Liveboard from a question                          |
| Agent: code / embedded analytics           | No                                                                | **SpotterCode** — code-gen + embedding inside IDEs                              |
| Agent: agentic data prep                   | No                                                                | Yes (new 2026)                                                                  |
| Multi-step reasoning / Python              | Via generated Python (per question)                               | Spotter 3 generates Python when needed                                          |
| MCP support                                | No                                                                | Yes (Spotter 3 integrates with third-party software via MCP)                    |
| Spotter Semantics (trust + context for AI) | N/A                                                               | Yes (introduced March 2026 — semantic guardrails for enterprise AI)             |
| Verified answers                           | Methodology disclosure on every analysis                          | Yes (verified answers via the semantic model)                                   |
| Schema-aware generation                    | Yes (column types, distributions, correlations, FK relationships) | Yes (modeled semantic layer)                                                    |
| Multi-provider LLM                         | Yes (7 providers + 3 local backends)                              | No (ThoughtSpot-managed AI)                                                     |
| Local / offline LLM                        | Yes (MLX, llama.cpp, Ollama)                                      | No                                                                              |
| Output style control                       | Yes (6 styles)                                                    | No (search-result + Liveboard format)                                           |
| Drill-down re-analysis                     | Yes (click chart segment → new AI analysis)                       | Yes (Drill Anywhere within Liveboards)                                          |
| Follow-up questions                        | Yes (server-side conversation cache, 5 turns)                     | Yes (Spotter conversational refinement)                                         |
| Schema-only privacy                        | **Yes — LLM never sees data values**                              | No (Spotter reasons over governed data)                                         |

**Major 2025–2026 shift**: ThoughtSpot is now **fully agentic**. Spotter 3 is the conversational lead, with **SpotterModel**, **SpotterViz**, and **SpotterCode** as specialist agents covering modeling, dashboarding, and code/embedding. **SpotCache** (unlimited analytics for AI workloads with fixed cloud costs) and **Spotter Semantics** (trust/context guardrails) are the headline platform additions.

**Hermetic wins on generative composition with privacy** — produces complete multi-component dashboards from a single question, and the LLM never sees row values. **ThoughtSpot wins on agentic depth and proactive intelligence** — SpotIQ surfaces anomalies without being asked, monitors run on a schedule, and the four-agent Spotter family handles the full analytics lifecycle.

---

## Visualization

| Feature                                        | Hermetic                               | ThoughtSpot                       |
| ---------------------------------------------- | -------------------------------------- | --------------------------------- |
| Native chart types                             | 35+ (AI-selected from JSON spec)       | ~15 built-in                      |
| Bar (grouped, stacked)                         | Yes                                    | Yes                               |
| Line / Area                                    | Yes                                    | Yes                               |
| Pie / Donut                                    | Yes                                    | Yes                               |
| Scatter                                        | Yes                                    | Yes                               |
| Table / Pivot                                  | DataTable (no pivot)                   | Yes (with pivot)                  |
| KPI / Headline                                 | StatCard + TrendIndicator              | Yes (Headline viz)                |
| Heatmap                                        | Yes                                    | Yes                               |
| Treemap                                        | Yes                                    | Yes                               |
| Geo map                                        | Yes (MapLibre, Globe3D, deck.gl Map3D) | Yes (basic geo)                   |
| Sankey                                         | Yes (native)                           | No                                |
| Chord / Stream / Marimekko                     | Yes (native)                           | No                                |
| Violin / Ridgeline / Beeswarm                  | Yes                                    | No                                |
| Bump / Slope / Dumbbell                        | Yes                                    | No                                |
| Waterfall / Bullet                             | Yes                                    | No                                |
| Candlestick                                    | Yes                                    | No                                |
| Parallel coordinates                           | Yes                                    | No                                |
| 3D charts (Scatter3D, Surface3D, Globe3D)      | Yes                                    | No                                |
| Deck.gl maps (5 layer types, with click/hover) | Yes                                    | No                                |
| ML charts (ROC, SHAP, confusion matrix)        | Yes (native)                           | No                                |
| Decision tree                                  | Yes                                    | No                                |
| Calendar heatmap                               | Yes                                    | No                                |
| Custom Python / R charts                       | Yes (sandbox)                          | Yes (via Analyst Studio R/Python) |

**Hermetic wins on chart diversity** (35+ native types) including specialized ML, 3D, financial, and geographic visualizations. **ThoughtSpot wins on chart simplicity** — fewer types but optimized for search-driven exploration with automatic axis/aggregation selection, plus pivot tables in Liveboards.

---

## Interactive Features

| Feature                 | Hermetic                                   | ThoughtSpot                            |
| ----------------------- | ------------------------------------------ | -------------------------------------- |
| Search bar (core UX)    | Question box                               | Yes (type-ahead search is the product) |
| Conversational AI agent | Follow-up questions                        | Yes (Spotter 3)                        |
| Drill-down              | Yes (AI re-analysis with filtered context) | Yes (Drill Anywhere in Liveboards)     |
| Cross-filtering         | Yes (DataController)                       | Yes (native)                           |
| Dynamic filters         | Yes (SelectControl)                        | Yes (runtime filters)                  |
| Liveboards (dashboards) | AI-generated per question                  | Yes (persistent, pinned answers)       |
| Auto-built Liveboards   | Whole product                              | Yes (SpotterViz)                       |
| Spreadsheet data prep   | No                                         | Yes (new 2026 — governed, scalable)    |
| Scheduled reports       | No                                         | Yes (email, Slack)                     |
| Alerts / Monitoring     | No                                         | Yes (Monitor — threshold-based)        |
| Mobile app              | No                                         | Yes (iOS, Android)                     |

**ThoughtSpot wins on enterprise interactivity** — persistent Liveboards, scheduled reports, mobile app, monitors, agentic data prep. **Hermetic wins on zero-effort creation** — no Liveboard to pin, no semantic model to build.

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
| MCP integrations       | No       | Yes (Spotter 3)                   |
| SSO / SAML             | No       | Yes                               |
| Audit logs             | No       | Yes                               |
| Verified answers       | No       | Yes (Spotter Semantics)           |

**ThoughtSpot wins on enterprise collaboration and governance.** Hermetic is single-user.

---

## Export

| Feature                    | Hermetic                    | ThoughtSpot              |
| -------------------------- | --------------------------- | ------------------------ |
| PDF                        | Yes (themed, multi-page A4) | Yes                      |
| DOCX                       | **Yes (landscape)**         | No                       |
| PPTX                       | Yes                         | No                       |
| PNG                        | Yes (2× pixel ratio)        | Yes                      |
| CSV                        | Yes                         | Yes                      |
| XLSX (multi-sheet, styled) | Yes                         | Yes                      |
| Code download (Python)     | Yes                         | Yes (via Analyst Studio) |
| Scheduled email            | No                          | Yes                      |
| Slack delivery             | No                          | Yes                      |
| API export                 | No                          | Yes                      |

**Hermetic wins on document formats** (DOCX, PPTX). **ThoughtSpot wins on automated delivery.**

---

## Deployment & Privacy

| Feature                    | Hermetic                      | ThoughtSpot                                                     |
| -------------------------- | ----------------------------- | --------------------------------------------------------------- |
| Self-hosted                | Yes (fully)                   | Yes (ThoughtSpot Software)                                      |
| Cloud                      | No (local-first)              | Yes (ThoughtSpot Cloud)                                         |
| Fully offline / air-gapped | Yes (Docker + local LLM)      | Possible (on-prem) but Spotter cloud LLMs may not be air-gapped |
| Open source                | Yes (MIT)                     | No                                                              |
| Data stays on-premise      | Yes (always)                  | Yes (on-prem option)                                            |
| LLM never sees row data    | **Yes (schema-only context)** | No (Spotter reasons over data)                                  |
| FedRAMP                    | N/A                           | Yes (Government Cloud)                                          |
| SOC 2                      | N/A (self-hosted)             | Yes                                                             |
| HIPAA                      | N/A (self-hosted)             | Yes                                                             |
| GDPR                       | N/A (self-hosted)             | Yes                                                             |

**Both can be self-hosted.** Hermetic is free and open source with provably air-gapped AI. ThoughtSpot self-hosted requires enterprise licensing and Spotter's full agentic capabilities depend on cloud LLM availability.

---

## Pricing Comparison (April 2026)

|                                         | Hermetic      | ThoughtSpot Pro                      | ThoughtSpot Enterprise                    |
| --------------------------------------- | ------------- | ------------------------------------ | ----------------------------------------- |
| **Price**                               | Free (OSS)    | $50/user/mo (annual)                 | Custom (typical $100K–$500K+/yr)          |
| Spotter AI Agent                        | N/A           | Yes (capped: **25 queries/user/mo**) | Yes (unlimited)                           |
| User range                              | Unlimited     | 25–1,000                             | Unlimited                                 |
| Data capacity                           | Your hardware | 250M rows                            | Unlimited                                 |
| SpotIQ insights                         | N/A           | Limited                              | Yes                                       |
| Liveboards                              | AI-generated  | Yes                                  | Yes                                       |
| SpotterViz / SpotterModel/Code          | N/A           | Available                            | Available                                 |
| Monitors / Alerts                       | No            | Yes                                  | Yes                                       |
| Embedding (ThoughtSpot Everywhere)      | No            | Limited                              | Yes                                       |
| Analyst Studio (SQL/Python/R notebooks) | No            | Yes                                  | Yes                                       |
| SSO / RBAC / audit                      | No            | Yes                                  | Yes                                       |
| Self-hosted                             | Yes           | No (Cloud only)                      | Yes (Software / FedRAMP Government Cloud) |
| BYO LLM                                 | Yes           | No                                   | Limited                                   |

A team of 20 users on ThoughtSpot Pro = ~$1,000/month or ~$12,000/year, **plus** the 25-query/user/month Spotter cap that triggers overages. Mid-market Enterprise contracts typically start at **~$100K–$300K/year** with implementation services adding $50K–$200K. Hermetic costs $0.

---

## What's New Since the Previous Version of This Comparison

**ThoughtSpot (since March 2026):**

- **Spotter 3** — upgraded conversational AI agent. Generates Python when needed. Integrates with third-party software via **Model Context Protocol (MCP)**.
- **SpotterModel** — semantic modeling agent (proposes tables, joins, logic from NL).
- **SpotterViz** — dashboarding agent that automatically builds a complete Liveboard from a question.
- **SpotterCode** — code generation + embedded analytics support inside IDEs.
- **Spotter Semantics** (March 2026) — trust and context guardrails for enterprise AI; verified-answer infrastructure.
- **Agentic Data Prep** + **native spreadsheet interface** — governed, scalable data prep alongside Spotter.
- **SpotCache** — unlimited analytics usage for AI workloads with fixed cloud costs.
- **Apache Iceberg** support across the platform.
- **Mode → Analyst Studio** integration is fully GA — SQL, Python, R notebooks live inside ThoughtSpot. Mode no longer exists as a standalone product.

**Hermetic (since March 2026):**

- **Parquet & DuckDB support** with Hive-partitioned folder detection. DuckDB always available alongside pandas in the sandbox.
- **Local file browser with bind-mount execution** — read-only mount of any host file or folder, no copy.
- **Persistent analysis history** with replay/restore/delete buttons.
- **Server-side conversation cache** for follow-up questions (5 turns, 30-min TTL).
- **Globe arc filtering** for origin-destination flow visualizations on the 3D globe.
- **300-second sandbox timeout** for large Parquet workloads.
- **Saved warehouse connections as one-click pills** on the home screen.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **complete dashboards from a single question** with no manual building, pinning, or modeling
- **Data privacy is non-negotiable** (air-gapped, fully local, LLM never sees row values)
- You need **35+ chart types** including specialized 3D, geographic, ML, financial, and calendar visualizations
- You want **zero cost** and no vendor lock-in
- You want **Parquet / DuckDB / local-file zero-copy ingestion**
- You're a **solo analyst or small team**
- You want to **choose your own LLM provider** or run locally (Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)

### Choose ThoughtSpot when:

- You need **enterprise search-driven analytics** with persistent Liveboards for hundreds or thousands of business users
- You want **agentic AI that covers the full analytics lifecycle** — modeling (SpotterModel), dashboarding (SpotterViz), embedded code (SpotterCode), conversation (Spotter 3)
- You want **proactive AI insights** (SpotIQ anomaly detection, Monitors with email/Slack alerts)
- You need **verified, governed AI answers** via a curated semantic layer (Spotter Semantics)
- You need **20+ native data warehouse connectors** plus Iceberg and dbt integration
- You need **Mode-style code-first SQL / Python / R notebooks** (Analyst Studio)
- You need **embedded analytics** (ThoughtSpot Everywhere) and white-label deployments
- You need **enterprise governance** (RBAC, RLS, audit logs, SOC2/HIPAA, FedRAMP Government Cloud)
- You have a **large team** that needs collaboration, sharing, and Slack/email delivery

### The Fundamental Difference

**Hermetic** generates a complete, multi-widget dashboard from a single question — AI does everything, and the LLM never sees a single row of data. The user's job is to ask the right question.

**ThoughtSpot** is now a **fully agentic enterprise analytics platform**. Spotter 3 is the conversational front door; SpotterModel/SpotterViz/SpotterCode handle modeling, visualization, and embedded code. Mode's notebook capabilities power Analyst Studio. AI assists across the full analytics lifecycle, but reasons over governed data with full row-level access.

Hermetic is "give me the answer." ThoughtSpot is "let agents drive my entire analytics stack — modeling, dashboarding, monitoring, embedding."

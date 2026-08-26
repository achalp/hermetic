# Hermetic vs ThoughtSpot — Competitive Feature Comparison

_Last updated: 2026-06-20_

_Previous versions of this comparison: [2026-04-25](./hermetic-vs-thoughtspot-2026-04-25.md), [un-dated original](./hermetic-vs-thoughtspot.md). This update reflects two waves of changes on the Hermetic side. **Wave 1 (2026-04-25 → 2026-05-31):** Snowflake and Databricks connectors (Hermetic now reaches seven warehouses), the **Investigate** multi-step agent, scheduled dashboard runs, persistent analysis history, edit-and-rerun on generated Python/SQL, interactive pivot tables, multi-retry with reflection, suggested follow-up questions, and dbt metadata enrichment. **Wave 2 (2026-05-31 → 2026-06-20):** per-analysis LLM cost tracking (live footer + per-day CSV + `/cost` page), a major LLM-cost optimization pass (Anthropic ephemeral prompt caching, cheaper models, fewer retries, lazy cells), the native chart library expanded from 32 to 57 AI-selected types, Investigate **Notebook mode** with Markdown/HTML/PDF/Slides export, output styles consolidated to four, an onboarding/landing redesign, and a reliability fix so local models no longer crash on hard-coded value assertions. ThoughtSpot-side claims and pricing are carried forward unchanged from the 2026-04-25 baseline. Hermetic remains single-user and local-first — the enterprise BI, governed-semantic-layer, and embedded-analytics territory is still ThoughtSpot's._

## Overview

| Category        | Hermetic                                                                                      | ThoughtSpot                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Core Model**  | AI-first: question to multi-widget dashboard; **Investigate** multi-step agent for deep-dives | Agentic analytics platform — Spotter agents (Spotter 3, SpotterModel, SpotterViz, SpotterCode) + Liveboards + Analyst Studio |
| **Deployment**  | Self-hosted / local-first                                                                     | Cloud (ThoughtSpot Cloud) or self-hosted (ThoughtSpot Software, Government Cloud / FedRAMP)                                  |
| **Pricing**     | Open source (free); **per-analysis LLM cost tracked locally**                                 | Pro $50/user/mo (25 Spotter queries/user/mo, 250M rows); Enterprise custom (~$100K–$500K+/yr)                                |
| **Target User** | Solo analyst, privacy-sensitive orgs                                                          | Enterprise data teams + business users; large deployments                                                                    |
| **Acquisition** | N/A                                                                                           | Mode Analytics ($200M, 2023) — fully integrated as Analyst Studio (GA early 2025)                                            |
| **AI Posture**  | LLM never sees the data (schema-only context)                                                 | Spotter agents reason over a governed semantic model with full data access                                                   |

---

## Data Sources

| Feature                               | Hermetic                                                                 | ThoughtSpot                                             |
| ------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| CSV upload                            | Yes (100MB)                                                              | Yes (via Analyst Studio or admin upload)                |
| Excel upload                          | Yes (multi-sheet + relationship detection)                               | Limited                                                 |
| GeoJSON native                        | Yes                                                                      | No                                                      |
| Parquet (single + Hive folders)       | Yes (DuckDB-backed, zero-copy bind-mount)                                | Via warehouse / Iceberg                                 |
| Local file browser                    | Yes (sandbox bind-mount of host fs)                                      | No                                                      |
| PostgreSQL                            | Yes                                                                      | Yes                                                     |
| BigQuery                              | Yes                                                                      | Yes                                                     |
| ClickHouse                            | Yes                                                                      | No                                                      |
| Trino / Starburst                     | Yes                                                                      | Yes                                                     |
| Hive                                  | Yes                                                                      | Yes                                                     |
| Snowflake                             | **Yes (new — inline + saved connections, dialect-aware SQL)**            | Yes (primary connector)                                 |
| Databricks (incl. Unity Catalog)      | **Yes (new — `@databricks/sql` driver; Unity Catalog browsing not yet)** | Yes (primary connector)                                 |
| Redshift                              | No                                                                       | Yes                                                     |
| Azure Synapse                         | No                                                                       | Yes                                                     |
| Oracle                                | No                                                                       | Yes                                                     |
| SQL Server                            | No                                                                       | Yes                                                     |
| Teradata                              | No                                                                       | Yes                                                     |
| SAP HANA                              | No                                                                       | Yes                                                     |
| Google Sheets                         | No                                                                       | Yes (via Analyst Studio)                                |
| dbt integration                       | **Partial (new — column-level metadata enrichment into LLM context)**    | Yes (Analyst Studio + dbt-aware modeling)               |
| Custom JDBC                           | No                                                                       | Yes                                                     |
| Apache Iceberg                        | No                                                                       | Yes                                                     |
| Mode SQL/Python/R notebooks           | No                                                                       | Yes (Analyst Studio — Mode's successor since 2025)      |
| Spreadsheet UI for governed data prep | No                                                                       | Yes (new in 2026 — agentic data prep alongside Spotter) |

**What changed on the Hermetic side:** the April doc listed Snowflake and Databricks as **No**; both now ship with first-class connectors (inline + saved connection forms, dialect-aware SQL-generation prompts), bringing Hermetic to **seven warehouses** — PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, and Hive. dbt metadata enrichment is also new — column-level descriptions flow into the same schema-only LLM context as the warehouse schema.

**ThoughtSpot wins decisively on enterprise data source breadth** — 20+ native connectors, Iceberg, dbt-aware modeling, plus the Analyst Studio code-first surface and governed spreadsheet data prep. **Hermetic wins on local + file-format intelligence** — Parquet folders bind-mounted into the sandbox, multi-sheet Excel relationship detection, and GeoJSON without any modeling.

---

## AI / NL Capabilities

| Feature                                    | Hermetic                                                                                                                                            | ThoughtSpot (April 2026)                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| NL to complete dashboard                   | Yes (one prompt → multi-widget JSON-Render)                                                                                                         | **Yes (SpotterViz — turns data into a complete Liveboard automatically)**       |
| NL to SQL                                  | Yes (7 dialects, cross-table JOINs, per-warehouse prompt guidance)                                                                                  | Yes (via Sage / Spotter)                                                        |
| Search-driven analytics                    | Question box                                                                                                                                        | Yes (type-ahead search bar is the long-standing core UX)                        |
| AI-generated insights                      | Yes (data-domain detection — financial, time-series, statistical)                                                                                   | Yes (SpotIQ — auto-anomaly detection, trend analysis)                           |
| Autonomous multi-step deep-dive            | **Yes (new — Investigate: planner decomposes into 3–7 sub-questions, orchestrator runs parallel/serial waves, composer synthesizes one dashboard)** | Yes (SpotIQ auto-insights + Spotter 3 agentic reasoning)                        |
| Proactive alerts / monitoring              | No                                                                                                                                                  | Yes (Monitor — threshold-based alerts via email/Slack)                          |
| Agentic analytics (autonomous)             | **Partial (new — Investigate orchestrates a multi-step plan, still single product surface)**                                                        | **Yes — 100% of platform is agentic in 2026 (Spotter 3 + 3 specialist agents)** |
| Agent: semantic modeling                   | No                                                                                                                                                  | **SpotterModel** — proposes tables, joins, logic from NL                        |
| Agent: dashboard generation                | The whole product                                                                                                                                   | **SpotterViz** — generates a Liveboard from a question                          |
| Agent: code / embedded analytics           | No                                                                                                                                                  | **SpotterCode** — code-gen + embedding inside IDEs                              |
| Agent: agentic data prep                   | No                                                                                                                                                  | Yes (new 2026)                                                                  |
| Multi-step reasoning / Python              | Via generated Python (per question) + Investigate orchestration                                                                                     | Spotter 3 generates Python when needed                                          |
| Failure recovery (retry with reflection)   | **Yes (new — up to 3 retries; reflection prompt after 2 failures)**                                                                                 | Spotter retries internally                                                      |
| Edit-and-rerun on generated code           | **Yes (new — edit Python or SQL, re-runs downstream without re-prompting the LLM)**                                                                 | Yes (via Analyst Studio cells)                                                  |
| MCP support                                | No                                                                                                                                                  | Yes (Spotter 3 integrates with third-party software via MCP)                    |
| Spotter Semantics (trust + context for AI) | N/A                                                                                                                                                 | Yes (introduced March 2026 — semantic guardrails for enterprise AI)             |
| Verified answers                           | Methodology disclosure on every analysis                                                                                                            | Yes (verified answers via the semantic model)                                   |
| Schema-aware generation                    | Yes (column types, distributions, correlations, FK relationships, dbt descriptions)                                                                 | Yes (modeled semantic layer)                                                    |
| Multi-provider LLM                         | Yes (7 providers + 3 local backends)                                                                                                                | No (ThoughtSpot-managed AI)                                                     |
| Local / offline LLM                        | Yes (MLX, llama.cpp, Ollama)                                                                                                                        | No                                                                              |
| Per-analysis LLM cost tracking             | **Yes (new — live footer with last + session cost, per-day CSV, `/cost` page; local models $0 but tokens tracked)**                                 | No (consumption/credit-based pricing)                                           |
| LLM cost optimization                      | **Yes (new — Anthropic ephemeral prompt caching ~90% input discount, cheaper Sonnet/Haiku models, fewer retries, lazy cells)**                      | N/A (managed)                                                                   |
| Output style control                       | Yes (4 styles — Dashboard, Brief, Report, Deep dive)                                                                                                | No (search-result + Liveboard format)                                           |
| Drill-down re-analysis                     | Yes (click chart segment → new AI analysis)                                                                                                         | Yes (Drill Anywhere within Liveboards)                                          |
| Follow-up questions                        | Yes (server-side conversation cache, 5 turns) + **suggested follow-up pills (new)**                                                                 | Yes (Spotter conversational refinement)                                         |
| Schema-only privacy                        | **Yes — LLM never sees data values**                                                                                                                | No (Spotter reasons over governed data)                                         |

**On the Hermetic side, the autonomy gap narrows.** **Investigate** now decomposes a fuzzy question ("why did churn spike in Q1?") into 3–7 sub-questions, runs independents in parallel waves and dependents serially, and composes a single unified dashboard — with the planner seeing schema + stats only, never row values. This is Hermetic's comparable answer to ThoughtSpot's SpotIQ auto-insights and Spotter 3's agentic reasoning, on a single-user, fully-local footing. New this period too: a **per-analysis LLM cost** surface (live footer, per-day CSV, `/cost` page) — Hermetic shows exact local cost per analysis, a sharp contrast with ThoughtSpot's consumption/credit pricing.

**Major 2025–2026 shift on the ThoughtSpot side**: ThoughtSpot is now **fully agentic**. Spotter 3 is the conversational lead, with **SpotterModel**, **SpotterViz**, and **SpotterCode** as specialist agents covering modeling, dashboarding, and code/embedding. **SpotCache** (unlimited analytics for AI workloads with fixed cloud costs) and **Spotter Semantics** (trust/context guardrails) are the headline platform additions.

**Hermetic wins on generative composition with privacy** — produces complete multi-component dashboards from a single question, the LLM never sees row values, and you can see and optimize the exact LLM cost. **ThoughtSpot wins on agentic depth and proactive intelligence** — SpotIQ surfaces anomalies without being asked, monitors run on a schedule, and the four-agent Spotter family handles the full analytics lifecycle across an enterprise.

---

## Visualization

| Feature                                        | Hermetic                                              | ThoughtSpot                       |
| ---------------------------------------------- | ----------------------------------------------------- | --------------------------------- |
| Native chart types                             | **57 (new — up from 35; AI-selected from JSON spec)** | ~15 built-in                      |
| Bar (grouped, stacked)                         | Yes                                                   | Yes                               |
| Line / Area                                    | Yes                                                   | Yes                               |
| Pie / Donut                                    | Yes                                                   | Yes                               |
| Scatter                                        | Yes                                                   | Yes                               |
| Table / Pivot                                  | **DataTable + interactive PivotTable (new)**          | Yes (with pivot)                  |
| KPI / Headline                                 | StatCard + TrendIndicator                             | Yes (Headline viz)                |
| Heatmap                                        | Yes                                                   | Yes                               |
| Treemap                                        | Yes                                                   | Yes                               |
| Geo map                                        | Yes (MapLibre, Globe3D, deck.gl Map3D)                | Yes (basic geo)                   |
| Sankey                                         | Yes (native)                                          | No                                |
| Chord / Stream / Marimekko                     | Yes (native)                                          | No                                |
| Violin / Ridgeline / Beeswarm                  | Yes                                                   | No                                |
| Bump / Slope / Dumbbell                        | Yes                                                   | No                                |
| Waterfall / Bullet                             | Yes                                                   | No                                |
| Candlestick                                    | Yes                                                   | No                                |
| Parallel coordinates                           | Yes                                                   | No                                |
| 3D charts (Scatter3D, Surface3D, Globe3D)      | Yes                                                   | No                                |
| Deck.gl maps (5 layer types, with click/hover) | Yes                                                   | No                                |
| ML charts (ROC, SHAP, confusion matrix)        | Yes (native)                                          | No                                |
| Statistical / scientific / financial-KPI       | **Yes (new — expanded set in the 57-type library)**   | No                                |
| Decision tree                                  | Yes                                                   | No                                |
| Calendar heatmap                               | Yes                                                   | No                                |
| Custom Python / R charts                       | Yes (sandbox)                                         | Yes (via Analyst Studio R/Python) |

**Hermetic wins on chart diversity** — now **57 native types** (up from 35), AI-selected with no code, spanning statistics, ML, financial/KPI, scientific/temporal, 3D, and deck.gl maps, plus first-class **interactive pivot tables** (sort, drill-through/down, cross-filter, aggregator switcher, heatmap mode, multi-value/multi-aggregator). **ThoughtSpot wins on chart simplicity** — fewer types but optimized for search-driven exploration with automatic axis/aggregation selection, plus pivot tables in Liveboards.

---

## Interactive Features

| Feature                 | Hermetic                                                                   | ThoughtSpot                            |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| Search bar (core UX)    | Question box                                                               | Yes (type-ahead search is the product) |
| Conversational AI agent | Follow-up questions + **suggested follow-up pills (new)**                  | Yes (Spotter 3)                        |
| Drill-down              | Yes (AI re-analysis with filtered context)                                 | Yes (Drill Anywhere in Liveboards)     |
| Cross-filtering         | Yes (DataController) + **pivot cross-filter (new)**                        | Yes (native)                           |
| Dynamic filters         | Yes (SelectControl)                                                        | Yes (runtime filters)                  |
| Liveboards (dashboards) | AI-generated per question                                                  | Yes (persistent, pinned answers)       |
| Auto-built Liveboards   | Whole product                                                              | Yes (SpotterViz)                       |
| Notebook / cell view    | **Yes (new — Investigate Notebook mode; export Markdown/HTML/PDF/Slides)** | Yes (Analyst Studio notebooks)         |
| Spreadsheet data prep   | No                                                                         | Yes (new 2026 — governed, scalable)    |
| Scheduled reports       | **Yes (new — node-cron scheduler, local-only; no email/Slack)**            | Yes (email, Slack)                     |
| Persistent run history  | **Yes (new — auto-saves to disk, dedicated page, restore/re-run)**         | Yes (saved answers/Liveboards)         |
| Alerts / Monitoring     | No                                                                         | Yes (Monitor — threshold-based)        |
| Mobile app              | No                                                                         | Yes (iOS, Android)                     |

**ThoughtSpot wins on enterprise interactivity** — persistent Liveboards, scheduled reports with delivery, mobile app, monitors, agentic data prep. **Hermetic narrows the gap on creation-side workflow** — it now has a real cron scheduler (local-only — no email/Slack/embed yet), persistent on-disk analysis history with one-click restore/re-run, and an **Investigate Notebook mode** that renders the multi-step deep-dive as cells exportable to Markdown/HTML/PDF/Slides. **Hermetic still wins on zero-effort creation** — no Liveboard to pin, no semantic model to build.

---

## Collaboration & Sharing

| Feature                | Hermetic                           | ThoughtSpot                       |
| ---------------------- | ---------------------------------- | --------------------------------- |
| Sharing links          | No                                 | Yes (with permissions)            |
| User roles / RBAC      | No                                 | Yes (Admin, Author, Viewer, etc.) |
| Row-level security     | No                                 | Yes                               |
| Group management       | No                                 | Yes                               |
| Comments / annotations | No                                 | Yes (on Liveboards)               |
| Scheduled delivery     | No (scheduled runs are local-only) | Yes (email PDFs, Slack)           |
| Embedded analytics     | No                                 | Yes (ThoughtSpot Everywhere)      |
| White-label embedding  | No                                 | Yes                               |
| API access             | No                                 | Yes (REST, SDK, GraphQL)          |
| MCP integrations       | No                                 | Yes (Spotter 3)                   |
| SSO / SAML             | No                                 | Yes                               |
| Audit logs             | No                                 | Yes                               |
| Verified answers       | No                                 | Yes (Spotter Semantics)           |

**ThoughtSpot wins on enterprise collaboration and governance.** Hermetic is single-user. Hermetic's new scheduling and persistent history are local-only — they close part of the operational gap but add no distribution or multi-user surface.

---

## Export

| Feature                    | Hermetic                                                                            | ThoughtSpot              |
| -------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| PDF                        | Yes (themed, multi-page A4)                                                         | Yes                      |
| DOCX                       | **Yes (landscape)**                                                                 | No                       |
| PPTX                       | Yes                                                                                 | No                       |
| PNG                        | Yes (2× pixel ratio)                                                                | Yes                      |
| CSV                        | Yes                                                                                 | Yes                      |
| XLSX (multi-sheet, styled) | Yes                                                                                 | Yes                      |
| Slides export              | **Yes (new — Investigate Notebook → Slides; Slides is now an export, not a style)** | No                       |
| Markdown / HTML            | **Yes (new — Investigate Notebook export)**                                         | No                       |
| Code download (Python)     | Yes                                                                                 | Yes (via Analyst Studio) |
| Scheduled email            | No                                                                                  | Yes                      |
| Slack delivery             | No                                                                                  | Yes                      |
| API export                 | No                                                                                  | Yes                      |

**Hermetic wins on document formats** (DOCX, PPTX, and now Markdown/HTML/PDF/Slides from Notebook mode). **ThoughtSpot wins on automated delivery.**

---

## Deployment & Privacy

| Feature                          | Hermetic                                          | ThoughtSpot                                                     |
| -------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| Self-hosted                      | Yes (fully)                                       | Yes (ThoughtSpot Software)                                      |
| Cloud                            | No (local-first)                                  | Yes (ThoughtSpot Cloud)                                         |
| Fully offline / air-gapped       | Yes (Docker + local LLM)                          | Possible (on-prem) but Spotter cloud LLMs may not be air-gapped |
| Open source                      | Yes (MIT)                                         | No                                                              |
| Data stays on-premise            | Yes (always)                                      | Yes (on-prem option)                                            |
| LLM never sees row data          | **Yes (schema-only context)**                     | No (Spotter reasons over data)                                  |
| Per-analysis LLM cost visibility | **Yes (new — footer, per-day CSV, `/cost` page)** | No (consumption/credit-based)                                   |
| FedRAMP                          | N/A                                               | Yes (Government Cloud)                                          |
| SOC 2                            | N/A (self-hosted)                                 | Yes                                                             |
| HIPAA                            | N/A (self-hosted)                                 | Yes                                                             |
| GDPR                             | N/A (self-hosted)                                 | Yes                                                             |

**Both can be self-hosted.** Hermetic is free and open source with provably air-gapped AI — and now with exact, local per-analysis LLM cost visibility. ThoughtSpot self-hosted requires enterprise licensing and Spotter's full agentic capabilities depend on cloud LLM availability.

---

## Pricing Comparison (April 2026)

|                                         | Hermetic                                          | ThoughtSpot Pro                      | ThoughtSpot Enterprise                    |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| **Price**                               | Free (OSS)                                        | $50/user/mo (annual)                 | Custom (typical $100K–$500K+/yr)          |
| LLM cost                                | **Your own API/local cost, tracked per-analysis** | Bundled in consumption/credits       | Bundled in consumption/credits            |
| Spotter AI Agent                        | N/A                                               | Yes (capped: **25 queries/user/mo**) | Yes (unlimited)                           |
| User range                              | Unlimited                                         | 25–1,000                             | Unlimited                                 |
| Data capacity                           | Your hardware                                     | 250M rows                            | Unlimited                                 |
| SpotIQ insights                         | N/A                                               | Limited                              | Yes                                       |
| Liveboards                              | AI-generated                                      | Yes                                  | Yes                                       |
| SpotterViz / SpotterModel/Code          | N/A                                               | Available                            | Available                                 |
| Monitors / Alerts                       | No                                                | Yes                                  | Yes                                       |
| Embedding (ThoughtSpot Everywhere)      | No                                                | Limited                              | Yes                                       |
| Analyst Studio (SQL/Python/R notebooks) | No                                                | Yes                                  | Yes                                       |
| SSO / RBAC / audit                      | No                                                | Yes                                  | Yes                                       |
| Self-hosted                             | Yes                                               | No (Cloud only)                      | Yes (Software / FedRAMP Government Cloud) |
| BYO LLM                                 | Yes                                               | No                                   | Limited                                   |

A team of 20 users on ThoughtSpot Pro = ~~$1,000/month or ~$12,000/year, **plus** the 25-query/user/month Spotter cap that triggers overages. Mid-market Enterprise contracts typically start at **~~$100K–$300K/year** with implementation services adding $50K–$200K. Hermetic costs $0 in licensing — your only spend is your own LLM API usage (or $0 with a local model), and Hermetic now shows that cost per analysis and optimizes it with prompt caching and cheaper models.

_(ThoughtSpot pricing carried forward unchanged from the 2026-04-25 baseline.)_

---

## What's New Since the Previous Version of This Comparison

**On the Hermetic side (since 2026-04-25):**

_Wave 1 (2026-04-25 → 2026-05-31):_

- **Snowflake connector** — inline + saved connection forms, dialect-aware SQL prompts. Closes the biggest warehouse gap. Hermetic now supports **seven warehouses**: PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, Hive.
- **Databricks connector** — `@databricks/sql` driver, SQL warehouse + personal access token auth.
- **Investigate multi-step agent** — Hermetic's comparable autonomous deep-dive to ThoughtSpot's SpotIQ auto-insights and Spotter reasoning. Planner decomposes a question into 3–7 sub-questions, orchestrator runs independents in parallel waves and dependents serially, composer synthesizes one unified dashboard. Privacy posture unchanged (planner sees schema + stats only, never row values).
- **Scheduled dashboard runs** — node-cron scheduler, schedule popover on the dashboard toolbar, schedule pills on saved-viz cards with edit/delete in place. Local-only (no email/Slack/embed).
- **Persistent analysis history** — every analysis auto-saves to disk (code, results, visualizations), survives restarts, with a dedicated history page and one-click restore or re-run against fresh data.
- **Edit-and-rerun** on the generated Python or SQL — edit in the code editor; the server skips that generation step and re-runs everything downstream without re-prompting the LLM.
- **Interactive pivot tables** — sort, drill-through, drill-down, cross-filter with other widgets, aggregator switcher, heatmap mode, multi-value / multi-aggregator support.
- **Multi-retry with reflection** — up to 3 retries on failed code execution; after 2 failures the model gets the full failed-attempt history plus a reflection prompt.
- **Suggested follow-up questions** — inline pills after each analysis suggest the next obvious question.
- **dbt metadata enrichment** — column-level descriptions pulled into the schema-only LLM context alongside the warehouse schema.

_Wave 2 (2026-05-31 → 2026-06-20):_

- **Per-analysis LLM cost tracking** — middleware captures the whole Investigate fan-out with zero call-site threading. Surfaced three ways: a live footer (last + session cost), a per-day CSV (`data/cost/<date>.csv` with token buckets + `cost_usd`), and a `/cost` page plus `GET /api/cost` returning totals and a per-dataset breakdown. Local/unknown models cost $0 but still track tokens. In contrast to ThoughtSpot's consumption/credit pricing, Hermetic shows exact per-analysis LLM cost, fully local.
- **LLM cost optimization** — Anthropic ephemeral prompt caching (~90% input discount), cheaper Sonnet/Haiku model defaults, fewer retries, and lazy cells (defer LLM work until a cell is actually needed).
- **Chart library expanded 32 → 57 native AI-selected types** — adds statistics, ML, financial/KPI, scientific/temporal, plus 3D and deck.gl maps. Chart counts in this doc updated to 57.
- **Investigate Notebook mode** — renders the multi-step deep-dive as a cell view; export to Markdown, HTML, PDF, or Slides.
- **Output styles consolidated to four** — Dashboard, Brief, Report, Deep dive. (Slides is now an export rather than a style.)
- **Onboarding / landing redesign** — privacy-forward hero ("the model writes the code — it never sees your rows"), a payoff preview before upload, real drag-and-drop, a prominent sample dataset, and a trust strip.
- **Reliability** — generated code from local models no longer crashes on hard-coded value assertions.

**On the ThoughtSpot side:** ThoughtSpot's roadmap continues to advance the four-agent Spotter family, Spotter Semantics, agentic data prep, SpotCache, and Analyst Studio. Specific feature claims in this doc are carried forward from the 2026-04-25 baseline; consult ThoughtSpot's release notes for net-new features since then. No competitor changes have been invented or altered here.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **complete dashboards from a single question** with no manual building, pinning, or modeling
- You want a **multi-step deep-dive** ("why did X spike?") without orchestrating it yourself — **Investigate** does the decomposition, and **Notebook mode** renders it as exportable cells
- **Data privacy is non-negotiable** (air-gapped, fully local, LLM never sees row values)
- You need **57 chart types** including specialized 3D, geographic, ML, financial, scientific, and calendar visualizations, plus **interactive pivot tables**
- You want **zero licensing cost**, no vendor lock-in, and **exact per-analysis LLM cost visibility** with built-in cost optimization (prompt caching, cheaper models)
- You want **Parquet / DuckDB / local-file zero-copy ingestion**
- You connect to **Postgres, BigQuery, ClickHouse, Snowflake, Databricks, Trino, or Hive** and want dialect-aware SQL generation
- You need **scheduled dashboard refreshes** but don't need email/Slack distribution
- You're a **solo analyst or small team**
- You want to **choose your own LLM provider** or run locally (Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)

### Choose ThoughtSpot when:

- You need **enterprise search-driven analytics** with persistent Liveboards for hundreds or thousands of business users
- You want **agentic AI that covers the full analytics lifecycle** — modeling (SpotterModel), dashboarding (SpotterViz), embedded code (SpotterCode), conversation (Spotter 3)
- You want **proactive AI insights** (SpotIQ anomaly detection, Monitors with email/Slack alerts)
- You need **verified, governed AI answers** via a curated semantic layer (Spotter Semantics)
- You need **20+ native data warehouse connectors** plus Iceberg and dbt-aware modeling
- You need **Mode-style code-first SQL / Python / R notebooks** (Analyst Studio)
- You need **embedded analytics** (ThoughtSpot Everywhere) and white-label deployments
- You need **enterprise governance** (RBAC, RLS, audit logs, SOC2/HIPAA, FedRAMP Government Cloud)
- You have a **large team** that needs collaboration, sharing, and Slack/email delivery

### The Fundamental Difference

**Hermetic** generates a complete, multi-widget dashboard from a single question — AI does everything, and the LLM never sees a single row of data. For hard questions, Investigate decomposes them into sub-steps and Notebook mode renders the result as exportable cells; and you can see and optimize exactly what each analysis cost in LLM tokens. The user's job is to ask the right question.

**ThoughtSpot** is a **fully agentic enterprise analytics platform**. Spotter 3 is the conversational front door; SpotterModel/SpotterViz/SpotterCode handle modeling, visualization, and embedded code. Mode's notebook capabilities power Analyst Studio. AI assists across the full analytics lifecycle, but reasons over governed data with full row-level access.

Hermetic is "give me the answer — locally, privately, and at a cost I can see." ThoughtSpot is "let agents drive my entire enterprise analytics stack — modeling, dashboarding, monitoring, embedding."

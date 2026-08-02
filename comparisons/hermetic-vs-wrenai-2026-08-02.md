# Hermetic vs Wren AI — Competitive Feature Comparison

_Last updated: 2026-08-02_

_New addition to the comparison set (first version — no predecessors). Wren AI
was admitted following the Vanna evaluation
([hermetic-vs-vanna-2026-08-01](./hermetic-vs-vanna-2026-08-01.md)): with
Vanna's OSS repo archived in March 2026, Wren AI is the strongest **living**
open-source occupant of Hermetic's quadrant — open source, BYO/local LLM,
self-hosted, metadata-only LLM context — and it actively markets head-to-head
comparisons against Vanna, Databricks Genie, Snowflake Cortex, and Power BI._

## Verdict: is Wren AI a competitor?

**Yes — the most credible open-source competitor in the set.** Unlike Vanna (a
frozen framework) or the warehouse-native tier (locked to one engine), Wren AI
is an actively maintained (Apache 2.0, ~16.8k stars, pushed this week),
warehouse-agnostic, self-hostable GenBI platform with local-LLM support and a
governed semantic layer. It is a real product with a real company (Canner)
behind it, versus pages against half the landscape, and a commercial tier
priced by concurrent session rather than per seat. Three facts frame the
comparison:

1. **Different center of gravity: governance vs. analysis.** Wren AI's core
   asset is the MDL semantic layer — Git-versioned YAML defining models,
   relationships, metrics, and row/column-level access controls — compiled by
   a Rust engine (Apache DataFusion) that validates every generated query
   against it before execution. Hermetic's core asset is the analysis
   pipeline — sandboxed Python + SQL, Investigate decomposition, verification
   of every claimed number. Wren governs _what the SQL may say_; Hermetic
   verifies _what the analysis actually found_.
2. **The teachability race is now three-way.** Wren's context layer
   (MDL + version-controlled `instructions.md` + reusable skills + LanceDB
   memory) is the closest living analog to Hermetic's skills system — closer
   than Cortex Analyst's YAML models cited in the July landscape refresh, and
   more governed than Vanna's RAG training. What it still lacks: enforcement
   of _analysis_ rules (its dry-plan validation checks SQL against the schema
   and ACLs, not domain correctness) and executable helper code.
3. **2026 pivot to agent-first.** Wren is transitioning from its "GenBI
   Classic" chat UI toward a CLI (`pip install wrenai`), agent SDKs
   (LangChain, Pydantic AI), integrations with Claude Code / Cursor / Cline,
   and WASM browser-side dashboards deployable to Vercel/Cloudflare. It is
   becoming infrastructure for other agents as much as a destination app —
   a bet that BI gets consumed through coding agents, not chat windows.

---

## Overview

| Category        | Hermetic                                                        | Wren AI                                                                          |
| --------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Core Model**  | AI-first application: question → complete interactive dashboard | Governed GenBI platform: semantic layer + Text-to-SQL + agent APIs               |
| **Deployment**  | Self-hosted / local-first                                       | Self-hosted OSS (Docker), Wren Cloud (SaaS), on-prem / air-gapped (commercial)   |
| **Pricing**     | Open source (free)                                              | OSS free (Apache 2.0); Cloud from $99/mo; concurrent-session licensing, no seats |
| **Target User** | Analyst who wants answers, no code, data stays local            | Data team standardizing governed self-serve analytics for business users         |
| **AI Posture**  | LLM never sees rows — schema-only context, blind execution      | Metadata-first: LLM works from MDL semantic model; engine validates output SQL   |
| **Status**      | Actively developed                                              | Actively developed (~16.8k stars, weekly pushes); company: Canner                |

---

## Data Sources

| Feature                                   | Hermetic                                  | Wren AI                                          |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| CSV / Excel / GeoJSON / JSON upload       | Yes (first-class, relationship detection) | Limited (DuckDB path; not the product's center)  |
| Parquet files (single + Hive-partitioned) | Yes (DuckDB-backed, zero-copy bind-mount) | Via DuckDB                                       |
| PostgreSQL                                | Yes                                       | Yes                                              |
| MySQL                                     | No                                        | Yes                                              |
| BigQuery                                  | Yes                                       | Yes                                              |
| Snowflake                                 | Yes (dialect-aware SQL)                   | Yes                                              |
| Databricks                                | Yes                                       | Yes                                              |
| ClickHouse                                | Yes                                       | Yes                                              |
| Trino                                     | Yes                                       | Yes                                              |
| Hive                                      | Yes                                       | Via Trino / Spark                                |
| Redshift                                  | Via PG-wire                               | Yes                                              |
| Oracle / SQL Server / Athena / Spark      | No                                        | Yes                                              |
| DuckDB                                    | Yes (in-sandbox engine)                   | Yes                                              |
| Semantic model over sources               | No (raw schema + dbt descriptions)        | Yes (MDL: models, relationships, metrics, cubes) |
| dbt metadata enrichment                   | Yes (column descriptions → LLM context)   | Yes (semantic-layer import path)                 |
| Cross-source federation                   | No (one source per analysis)              | Yes (DataFusion engine federates)                |

**Wren AI wins on warehouse breadth and modeling depth** — 20+ connectors
including Oracle, SQL Server, Athena, and Spark, plus a real semantic layer and
cross-source federation. **Hermetic wins on file-based and local data** — drag
a CSV/Excel/GeoJSON in and go, planet-scale Parquet without a warehouse —
and on zero-setup: Wren's accuracy premium is earned by building the MDL model
first; Hermetic introspects and goes.

---

## AI / LLM Capabilities

| Feature                         | Hermetic                                                                   | Wren AI                                                             |
| ------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| NL to SQL                       | Yes (dialect-aware, bounded scan windows, self-healing repair)             | Yes (MDL planning, schema retrieval, dry-plan validation — core)    |
| NL to Python analysis           | Yes (generates + executes blind in sandbox)                                | No (SQL only)                                                       |
| NL to complete dashboard        | Yes (one prompt → multi-widget spec)                                       | Yes (AI-generated dashboards; browser-side via wren-core-wasm)      |
| NL to chart                     | Yes (AI-selected from 57 types)                                            | Yes (Text-to-Chart)                                                 |
| Multi-step agentic analysis     | Yes (Investigate: planner → parallel waves → composer)                     | Partial (agent-first APIs orchestrate; no built-in decomposition)   |
| Multi-provider LLM              | Yes (7: Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama) | Yes (any LiteLLM provider — OpenAI, Anthropic, Gemini, Ollama, …)   |
| Local / offline LLM             | Yes (MLX, llama.cpp, Ollama, curated tiers)                                | Yes (Ollama for LLM + embedder)                                     |
| Pre-execution validation        | Yes (LLM critic enforces skill rules on generated code)                    | Yes (engine dry-plan validates SQL against MDL schema + ACLs)       |
| Grounded narrative verification | Yes (every number checked against computed results)                        | No                                                                  |
| Failure recovery                | Yes (3 retries, reflection, phase-accurate signals)                        | Yes (structured engine errors feed regeneration)                    |
| Per-analysis cost tracking      | Yes (footer + per-day CSV + `/cost` page, per-phase)                       | No user-facing per-question cost (session-based licensing)          |
| Row/column-level access control | No (single-user by design)                                                 | Yes (RLAC/CLAC in MDL, role-based access, audit logs — commercial)  |
| Agent / IDE integration         | No (destination app)                                                       | Yes (Claude Code, Cursor, Cline; LangChain + Pydantic AI SDKs; CLI) |
| LLM sees row data?              | Never (schema + stats only; blind execution)                               | Metadata-first (MDL + schema); results render engine/browser-side   |

**The two validation philosophies are complementary, and neither subsumes the
other.** Wren's dry-plan validation is _mechanical_: generated SQL is compiled
against the semantic layer before it runs, so schema errors and ACL violations
die deterministically — stronger than an LLM critic for that class of bug.
Hermetic's critic is _semantic_: it enforces domain analysis rules (won-only
revenue, significance before declaring a winner) that are perfectly valid SQL
and would sail through Wren's engine. **Wren wins on governance and agent
plumbing; Hermetic wins on analysis depth** — Python statistics, Investigate,
verification, and per-question cost visibility have no Wren equivalent.

---

## Teachability — MDL + instructions vs Hermetic skills

The closest living analog to Hermetic's skills in the landscape, and the most
important section of this comparison.

| Dimension         | Hermetic skills                                                                       | Wren AI context layer                                                      |
| ----------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Unit of knowledge | Folder: `SKILL.md` + optional `helpers.py`                                            | MDL YAML (models, metrics, relationships) + `instructions.md` + skills     |
| What it encodes   | The _analysis_: prompt guidance, reviewer rules, failure hints, tested Python helpers | The _data + business logic_: definitions, metrics, ACLs, phrasing guidance |
| Version control   | Files on disk (Git-able)                                                              | Yes — explicitly Git-native (branch, review, own)                          |
| Retrieval         | Activation triggers (column regexes, keywords, source kind)                           | Hybrid retrieval over MDL + memory (LanceDB)                               |
| Enforcement       | LLM critic rejects violating _analysis code_ pre-execution                            | Engine rejects invalid/unauthorized _SQL_ pre-execution                    |
| Executable code   | Yes (`skill_lib.<name>` helpers import into the sandbox)                              | No                                                                         |
| Metric governance | No (skills guide, but no central metric definitions)                                  | Yes (metrics/cubes defined once in MDL, reused everywhere)                 |
| Live reload       | Yes (drop in folder, next question)                                                   | Model redeploy on MDL change                                               |

**Wren governs definitions; Hermetic governs method.** If the failure mode you
fear is "two dashboards disagree on what revenue means," Wren's MDL is the
stronger answer — one versioned definition, mechanically enforced, with access
control attached. If the failure mode is "the analysis is fluent, valid, and
methodologically wrong," Hermetic's skills are the only mechanism in the
landscape that addresses it — reviewer rules plus tested helper code. The July
landscape refresh's claim that skills' closest analogs "describe the _data_"
still holds for Wren, but Wren's version-controlled `instructions.md` and
reusable skills are inching toward the analysis side; this is the competitor
to watch on that axis.

---

## Visualization & Product Surface

| Feature                      | Hermetic                                         | Wren AI                                                   |
| ---------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Native chart types           | 57 (AI-selected)                                 | Standard BI set (Text-to-Chart; no published count)       |
| Multi-widget dashboards      | Yes (adaptive layout, cross-filtering, pivots)   | Yes (AI-generated, browser-side WASM, shareable)          |
| Interactive pivot tables     | Yes                                              | No                                                        |
| 3D / geo / ML chart families | Yes (deck.gl, Globe3D, SHAP, ROC, Kaplan–Meier…) | No                                                        |
| Output styles                | 4 (Dashboard, Brief, Report, Deep dive)          | Fixed (answer + chart + dashboard)                        |
| Document export              | PDF, DOCX, PPTX, XLSX, PNG, Markdown/HTML/Slides | Dashboard sharing / GenBI app deploy (Vercel, Cloudflare) |
| Embedding in other products  | No                                               | Yes (GenBI apps, SDKs, agent APIs — a product pillar)     |
| Scheduled runs               | Yes (node-cron on saved dashboards)              | Cloud/commercial feature                                  |
| Multi-user / sharing         | No                                               | Yes (shareable dashboards, unlimited users on paid plans) |
| Analysis history             | Yes (persistent, browsable, restorable)          | Conversation history + versioned context files            |

**Closer than any other open-source entrant on the output surface** — Wren
genuinely generates dashboards, not just single charts — but the depth differs:
Hermetic's 57 AI-selected chart types, pivots, statistical/ML visuals, and
document exports against Wren's standard BI set. **Wren wins on distribution**:
shareable browser-side dashboards, deployable GenBI apps, and multi-user access
are exactly the sharing story Hermetic deliberately lacks (the static-export
spec remains open).

---

## Deployment, Privacy & Governance

| Feature                    | Hermetic                                | Wren AI                                                          |
| -------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Self-hosted                | Yes (fully)                             | Yes (OSS Docker; commercial on-prem)                             |
| Fully offline / air-gapped | Yes (Docker + local LLM)                | Yes (air-gapped is a marketed commercial deployment)             |
| Open source                | Yes (MIT), actively developed           | Yes (Apache 2.0), actively developed                             |
| Sandboxed code execution   | Yes (Docker `--network none` / microVM) | N/A (no arbitrary code — SQL only, engine-validated)             |
| LLM context                | Schema + stats only, never rows         | MDL + schema (metadata-first); results render engine-side        |
| Multi-tenant / RBAC / RLS  | No                                      | Yes (RLAC/CLAC, roles, audit logs — commercial tiers)            |
| Compliance posture         | N/A (self-hosted, single-user)          | "Sovereign AI analytics" positioning; audit logs, ACLs           |
| Maintenance risk           | Low (active)                            | Low-moderate (active; VC-backed startup, monetization via Cloud) |

**Both are genuinely private-by-architecture — for different reasons.** Wren
never executes arbitrary generated code, so it needs no sandbox; its exposure
surface is governed SQL against a semantic layer, with dashboards rendering in
the browser via WASM. Hermetic executes arbitrary Python, and contains it with
a network-disabled sandbox and blind execution. Wren's metadata-first posture
is the nearest thing in the landscape to Hermetic's schema-only claim — the
difference shows up in what each system can _do_ with that privacy: Wren stays
inside SQL's expressive bounds; Hermetic runs full statistical computation
without widening what the model sees.

---

## Pricing

|                         | Hermetic                           | Wren OSS          | Wren Cloud                                 | Wren on-prem / enterprise                            |
| ----------------------- | ---------------------------------- | ----------------- | ------------------------------------------ | ---------------------------------------------------- |
| **Price**               | Free (OSS) + your LLM/compute      | Free (Apache 2.0) | From $99/mo (Starter), $299/mo (Essential) | Concurrent-session licensed, custom                  |
| Licensing unit          | N/A                                | N/A               | Usage-based                                | Concurrent sessions (~5 users each), unlimited seats |
| LLM                     | BYO (7 providers incl. local)      | BYO via LiteLLM   | Managed                                    | BYO / sovereign                                      |
| Cost visibility         | Exact per-analysis (CSV + `/cost`) | DIY               | Plan-level                                 | Plan-level                                           |
| Governance (ACL, audit) | No                                 | Partial           | Yes                                        | Yes                                                  |

Wren's concurrent-session model (no per-seat fees, ~5 active users per
session) undercuts seat-priced BI for large audiences — a team of 50 casual
users might run on a Business plan's 5 sessions, versus ~$45K/yr on
ThoughtSpot Pro seats. Hermetic remains $0 + compute, with the tradeoff
unchanged: no multi-user story at all.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **analysis, not just answers** — Python statistics, ML charts, Investigate decomposition, verification of every claimed number
- **Files are your data** — CSV, Excel, GeoJSON, planet-scale Parquet, no warehouse required
- You want **zero setup** — no semantic model to build before the first question
- You need **method enforcement** — skills with reviewer rules and tested helpers, not just metric definitions
- You want **per-question cost transparency** and a fully local footprint
- You're a **solo analyst or small team** with no sharing requirement

### Choose Wren AI when:

- You need **governed self-serve BI for a whole org** — one metric layer, RLAC/CLAC, audit logs, unlimited users
- Your data lives in **many warehouses** (incl. Oracle, SQL Server, Athena, Spark) or needs **cross-source federation**
- You want **shareable dashboards and embeddable GenBI apps** as first-class outputs
- You're building **agent workflows** — CLI, LangChain/Pydantic AI SDKs, Claude Code / Cursor integration
- You want **deterministic SQL validation** against a versioned semantic model
- You need a **maintained open-source** platform with a commercial support path

### The Fundamental Difference

**Hermetic** is a private analyst: one user, any data (including a bare file),
full computational depth, every number verified, every dollar visible — and
the model never sees a row.

**Wren AI** is a governed answer layer: a data team encodes business truth
once in a versioned semantic model, and the whole org (and its agents) asks
questions against it, with the engine mechanically guaranteeing the SQL
respects schema and access rules.

Hermetic verifies the analysis; Wren governs the definitions. An org could
plausibly run both — Wren as the shared metric layer, Hermetic as the deep-dive
tool — which is precisely why Wren is the competitor to watch: it is the only
active open-source player converging on Hermetic's quadrant from the
governance side.

---

## Sources

- [WrenAI GitHub repo (Apache 2.0, ~16.8k stars)](https://github.com/Canner/WrenAI) · [Wren AI OSS docs — introduction](https://docs.getwren.ai/oss/introduction)
- [Wren AI pricing (concurrent-session model)](https://www.getwren.ai/pricing) · [SaaSworthy — Wren AI plans ($99/$299)](https://www.saasworthy.com/product/wren-ai/pricing) · [Sovereign / on-prem positioning](https://www.getwren.ai/on-premise)
- [Wren AI vs Vanna (Wren's own comparison)](https://www.getwren.ai/post/wren-ai-vs-vanna-the-enterprise-guide-to-choosing-a-text-to-sql-solution) · [versus hub (Genie, Cortex, Power BI, ChatGPT)](https://www.getwren.ai/versus)
- [Custom LLM / embedder setup (LiteLLM, Ollama)](https://docs.getwren.ai/oss/ai_service/guide/custom_llm) · [Llama 3 via Ollama walkthrough](https://www.getwren.ai/post/how-to-use-meta-llama-3-to-query-mysql-database-using-ollama-and-wren-ai)
- [Dissecting open-source NL2SQL: Vanna vs WrenAI vs DB-GPT](https://sudiptapathak.com/blog/dissecting-open-source-nl2sql/) · [Colrows — Wren AI alternatives 2026](https://colrows.com/blogs/wren-ai-alternatives/)

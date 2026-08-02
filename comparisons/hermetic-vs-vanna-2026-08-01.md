# Hermetic vs Vanna.ai — Competitive Feature Comparison

_Last updated: 2026-08-01_

_New addition to the comparison set (first version — no predecessors). Vanna was
evaluated for inclusion after the 2026-07-31 landscape refresh and admitted:
it is the only product in the landscape that occupies Hermetic's own quadrant —
open source, BYO/local LLM, self-hosted, schema-only-by-default. That makes it
the "why not just use Vanna?" alternative a technical evaluator will raise,
even though it is a developer framework rather than an end-user product._

## Verdict: is Vanna a competitor?

**Yes — the closest architectural neighbor in the set, but not a product
competitor.** Vanna is an MIT-licensed text-to-SQL agent framework (~24k GitHub
stars) that a developer embeds in their own app; Hermetic is a finished
analytics application an analyst opens and uses. They compete for the same
technical buyer ("open-source, private, chat-with-my-database") but not for the
same end user. Two facts dominate the comparison:

1. **Vanna validates Hermetic's differentiation axes** — it is the only other
   player with a serious local-model path (Ollama), a schema-only-by-default
   privacy posture, and a teach-it-your-domain mechanism (RAG "training" on
   DDL / documentation / example SQL). The landscape refresh's claim that "no
   competitor offers a serious local-model path" needs a footnote now.
2. **The open-source project is frozen.** The main `vanna-ai/vanna` repo was
   archived (read-only) on 2026-03-29, months after the Vanna 2.0 rewrite
   shipped; `vanna-streamlit` was archived 2026-01-31. The company's commercial
   gravity has moved to **Vanna Cloud** (hosted access control, observability,
   vector storage, audit logs). Community forks are patching the archived
   codebase, but as of August 2026 the OSS path is unmaintained upstream.

---

## Overview

| Category        | Hermetic                                                        | Vanna.ai                                                                     |
| --------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Core Model**  | AI-first application: question → complete interactive dashboard | Developer framework: embed a text-to-SQL agent (`<vanna-chat>`) in your app  |
| **Deployment**  | Self-hosted / local-first                                       | Self-hosted library (OSS, archived) or Vanna Cloud (hosted admin plane)      |
| **Pricing**     | Open source (free)                                              | OSS free (MIT); historical hosted tier ~$0.53/query; Vanna Cloud custom      |
| **Target User** | Analyst who wants answers, no code, data stays local            | Developer building a "chat with your database" feature for their org/product |
| **AI Posture**  | LLM never sees rows — schema-only context, blind execution      | Schema + RAG training context by default; 2.0 sends result summaries to LLM  |
| **Status**      | Actively developed                                              | OSS repo archived 2026-03-29; commercial focus shifted to Vanna Cloud        |

---

## Data Sources

| Feature                                   | Hermetic                                  | Vanna                                            |
| ----------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| CSV / Excel / GeoJSON / JSON upload       | Yes (first-class, relationship detection) | No (databases only; files via DuckDB/SQLite DIY) |
| Parquet files (single + Hive-partitioned) | Yes (DuckDB-backed, zero-copy bind-mount) | Indirect (register in DuckDB yourself)           |
| PostgreSQL                                | Yes                                       | Yes                                              |
| MySQL                                     | No                                        | Yes                                              |
| SQLite                                    | No (files route through DuckDB)           | Yes                                              |
| BigQuery                                  | Yes                                       | Yes                                              |
| Snowflake                                 | Yes (dialect-aware SQL)                   | Yes                                              |
| Databricks                                | Yes                                       | Partial (via connector recipes)                  |
| Redshift                                  | Via PG-wire                               | Yes                                              |
| ClickHouse                                | Yes                                       | Yes                                              |
| Trino / Hive                              | Yes                                       | No                                               |
| Oracle / SQL Server                       | No                                        | Yes                                              |
| DuckDB                                    | Yes (in-sandbox engine)                   | Yes                                              |
| dbt metadata enrichment                   | Yes (column descriptions → LLM context)   | Manual (paste docs into training corpus)         |
| Schema introspection (FKs, cross-table)   | Yes (automatic, feeds JOIN generation)    | Semi-manual (train on DDL you supply)            |

**Vanna wins on classic-RDBMS breadth** (MySQL, Oracle, SQL Server, SQLite are
Vanna-only). **Hermetic wins everywhere data lives outside a database** — file
uploads, Parquet folders at planet scale, Excel relationship detection — and on
zero-setup introspection: Hermetic reads the schema itself; Vanna's accuracy
depends on the DDL and docs a developer feeds its training corpus.

---

## AI / LLM Capabilities

| Feature                            | Hermetic                                                                   | Vanna                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| NL to SQL                          | Yes (dialect-aware, bounded scan windows, self-healing repair)             | Yes (core competency; RAG-grounded, agentic retrieval in 2.0)                                   |
| NL to Python analysis              | Yes (generates + executes blind in sandbox)                                | No (SQL only; Plotly code for the chart)                                                        |
| NL to complete dashboard           | Yes (one prompt → multi-widget spec)                                       | No (one query → table + one chart + summary)                                                    |
| Multi-step agentic analysis        | Yes (Investigate: planner → parallel waves → composer)                     | Partial (2.0 agent loop is multi-turn tool-calling, not decomposition)                          |
| Multi-provider LLM                 | Yes (7: Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama) | Yes (OpenAI, Anthropic, Gemini, Mistral, Azure, Bedrock, Ollama)                                |
| Local / offline LLM                | Yes (MLX, llama.cpp, Ollama, curated tiers)                                | Yes (Ollama) — the only other set member with this                                              |
| Retry / failure recovery           | Yes (3 retries, reflection prompt, phase-accurate signals)                 | Basic (regenerate on SQL error)                                                                 |
| Pre-execution review gate          | Yes (LLM critic enforces skill rules before code runs)                     | No                                                                                              |
| Grounded narrative verification    | Yes (every number checked against computed results)                        | No (summary is LLM prose over results)                                                          |
| Per-analysis cost tracking         | Yes (footer + per-day CSV + `/cost` page, per-phase breakdown)             | 2.0 has cost-tracking middleware hooks (developer wires it)                                     |
| Conversation context               | Yes (server-side cache)                                                    | Yes (2.0 multi-turn, encrypted persistence)                                                     |
| Row-level security / user identity | No (single-user by design)                                                 | Yes (2.0's headline feature — identity flows through every tool)                                |
| LLM sees row data?                 | Never (schema + stats only; blind execution)                               | Not by default in v1 (schema/training only; opt-in flag); 2.0 sends result summaries to the LLM |

**The privacy postures look similar but diverge under load.** Vanna v1's pitch
("your database contents are never sent to the LLM") is genuinely the closest
claim to Hermetic's in the whole landscape — but it erodes at the edges: chart
generation and the 2.0 dual-output design feed result summaries back to the
model, and an `allow_llm_to_see_data` escape hatch exists for introspection.
Hermetic's blind execution is structural: results flow to the UI composer as
schemas and placeholders, never as values. **Vanna wins on multi-user
enterprise plumbing** — RLS, audit logs, quotas, identity — which Hermetic
deliberately doesn't have. **Hermetic wins on analysis depth**: Python + SQL,
Investigate decomposition, verification, and cost transparency out of the box.

---

## Teachability — Vanna training vs Hermetic skills

This is the most direct overlap in the set. Both let you teach the system your
domain; the mechanisms differ in kind.

| Dimension         | Hermetic skills                                                                       | Vanna training                                                |
| ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Unit of knowledge | Folder: `SKILL.md` + optional `helpers.py`                                            | Vector-store entries: DDL, documentation strings, Q→SQL pairs |
| What it encodes   | The _analysis_: prompt guidance, reviewer rules, failure hints, tested Python helpers | The _data_: schema semantics and known-good SQL examples      |
| Retrieval         | Activation triggers (column regexes, keywords, source kind)                           | Embedding similarity (RAG) per question                       |
| Enforcement       | Yes — pre-execution critic rejects violating code                                     | No — training biases generation, nothing checks the output    |
| Executable code   | Yes — helpers import into the sandbox as `skill_lib.<name>`                           | No — examples are retrieval context only                      |
| Live reload       | Yes (drop in folder, next question)                                                   | Yes (add training data at runtime)                            |
| Who authors it    | Analyst/team (markdown + Python)                                                      | Developer (API calls to `train()`)                            |

**Vanna's training corpus is the best-known implementation of "teach the model
your schema" and it demonstrably improves SQL accuracy.** But it is
suggestion-only: a retrieved example nudges generation, and nothing stops the
model from emitting a wrong-but-valid query. Hermetic's skills add the two
layers Vanna lacks — _enforcement_ (the critic gate) and _tested code_ (helpers
the generated code imports instead of re-deriving). The landscape refresh
called Cortex Analyst's YAML semantic models the closest analog to skills;
Vanna's training corpus is closer still, and the same distinction applies.

---

## Visualization & Product Surface

| Feature                       | Hermetic                                         | Vanna                                               |
| ----------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| Native chart types            | 57 (AI-selected)                                 | 1 auto-generated Plotly chart per query             |
| Multi-widget dashboards       | Yes (adaptive layout, cross-filtering, pivots)   | No                                                  |
| Interactive pivot tables      | Yes                                              | No                                                  |
| 3D / geo / ML chart families  | Yes (deck.gl, Globe3D, SHAP, ROC, Kaplan–Meier…) | No                                                  |
| Output styles                 | 4 (Dashboard, Brief, Report, Deep dive)          | Fixed (progress → table → chart → summary stream)   |
| Document export               | PDF, DOCX, PPTX, XLSX, PNG, Markdown/HTML/Slides | None built-in (developer implements)                |
| End-user UI                   | Full application (upload → ask → dashboard)      | `<vanna-chat>` web component + FastAPI SSE endpoint |
| Embedding in your own product | No                                               | Yes — this is the point of the framework            |
| Slack bot                     | No                                               | Yes (hosted tier, historical)                       |
| Scheduled runs                | Yes (node-cron on saved dashboards)              | No (developer implements)                           |
| Analysis history              | Yes (persistent, browsable, restorable)          | 2.0 encrypted conversation persistence              |

**Not close on the analytics surface — by design.** Vanna ships a chat widget
and expects the developer to build the rest; Hermetic ships the rest. Conversely
**Vanna wins on embeddability**: if the goal is "add chat-with-data to _our_
product," Hermetic has no answer and Vanna is purpose-built.

---

## Deployment, Privacy & Status

| Feature                    | Hermetic                                | Vanna                                                                                   |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| Self-hosted                | Yes (fully)                             | Yes (OSS library — but upstream archived)                                               |
| Fully offline / air-gapped | Yes (Docker + local LLM)                | Yes in principle (Ollama + local vector store)                                          |
| Open source                | Yes (MIT), actively developed           | Yes (MIT), **archived 2026-03-29**; community forks                                     |
| Sandboxed code execution   | Yes (Docker `--network none` / microVM) | No sandbox — SQL runs directly against your DB                                          |
| Hosted option              | No (local-first by design)              | Vanna Cloud (access control, observability, audit, retention)                           |
| Multi-tenant / RBAC / RLS  | No                                      | Yes (2.0 identity-first architecture)                                                   |
| Maintenance risk           | Low (active)                            | High for OSS path (frozen upstream, fork fragmentation); Cloud path is vendor-dependent |

**The archival is the strategic fact.** A team betting on Vanna OSS today
inherits a frozen codebase or picks a fork; the maintained path is Vanna Cloud,
which surrenders the self-hosted premise that made Vanna comparable to Hermetic
in the first place. Hermetic's pitch — open source _and_ maintained _and_
local-first — is exactly the combination Vanna no longer offers.

---

## Pricing

|                  | Hermetic                           | Vanna OSS                             | Vanna hosted (historical)            | Vanna Cloud         |
| ---------------- | ---------------------------------- | ------------------------------------- | ------------------------------------ | ------------------- |
| **Price**        | Free (OSS) + your LLM/compute      | Free (MIT, archived)                  | Free rate-limited; ~$0.53/query paid | Custom (contact)    |
| LLM              | BYO (7 providers incl. local)      | BYO (incl. Ollama)                    | Bundled (GPT-class)                  | BYO / bundled       |
| Cost visibility  | Exact per-analysis (CSV + `/cost`) | DIY middleware                        | Per-query metering                   | Observability plane |
| Engineering cost | None (finished app)                | Significant (build the app around it) | Moderate                             | Moderate            |

The real cost axis isn't dollars — both OSS options are free — it's
**engineering time**: Vanna is a component that needs an application built
around it; Hermetic is the application.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want a **finished analytics app** — question to dashboard, no code to write around it
- **Data privacy is structural**, not configurable — the LLM never sees rows, code runs in a network-disabled sandbox
- You need **analysis beyond SQL** — Python statistics, ML charts, multi-step Investigate, verification of every claimed number
- You want **files as first-class data** (CSV, Excel, Parquet at planet scale), not just databases
- You want an **actively maintained** open-source project
- You're a **solo analyst or small team**, not building a product

### Choose Vanna when:

- You're a **developer embedding chat-with-data into your own application** — the `<vanna-chat>` component and identity-aware tool framework are purpose-built for this
- You need **multi-user enterprise plumbing** — row-level security, audit logs, quotas, per-user permissions
- Your databases are **MySQL, Oracle, SQL Server, or SQLite**
- You need **Q→SQL example training** to hit accuracy targets on a well-known schema
- You accept the fork-or-Cloud tradeoff that comes with the archived upstream

### The Fundamental Difference

**Hermetic** is an open-source analytics _application_: an analyst asks a
question and gets a verified, multi-widget dashboard, with the model never
seeing a row and every artifact inspectable.

**Vanna** is (was) an open-source text-to-SQL _framework_: a developer trains it
on their schema and embeds a chat agent in their own product, with enterprise
identity plumbing as the 2.0 differentiator — and the maintained version of
that story now lives in a hosted cloud.

They meet at the same technical evaluator — "open source, private, BYO model,
chat with my data" — and diverge immediately after: build vs. use, SQL vs. full
analysis, suggestion vs. enforcement, and (since March 2026) frozen vs. alive.

---

## Sources

- [Vanna GitHub repo (archived 2026-03-29, ~24k stars)](https://github.com/vanna-ai/vanna) · [org repositories](https://github.com/orgs/vanna-ai/repositories)
- [Vanna docs — Why we built this / Vanna 2.0 rearchitecture](https://vanna.ai/docs/why-we-built-this) · [vanna.ai homepage — "The SQL Agent", Open Source + Vanna Cloud tiers](https://vanna.ai/)
- [Show HN: Vanna AI (Sept 2023)](https://news.ycombinator.com/item?id=37432896)
- [Bytebase — Top text-to-SQL tools 2026](https://www.bytebase.com/blog/top-text-to-sql-query-tools/) · [Towards AI — forking the archived 23k-star project](https://pub.towardsai.net/i-turned-an-archived-23k-star-text-to-sql-project-into-a-self-hosted-tool-that-actually-works-out-b08abcb6d0e3)
- [Vanna pricing history (~$0.53/query hosted tier)](https://aihungry.com/tools/vanna-ai/pricing) · [AIChief — Vanna 2.0 review 2026](https://aichief.com/ai-data-management/vanna-ai/)

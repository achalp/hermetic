# Hermetic vs Wren AI — Competitive Feature Comparison

_Last updated: 2026-08-05_

_Refresh of [hermetic-vs-wrenai-2026-08-02](./hermetic-vs-wrenai-2026-08-02.md),
incorporating the engineering audit
([competitor-audit-wren-2026-08-04](../audits/competitor-audit-wren-2026-08-04.md))
and three days of shipped hermetic work: MCP server v1 merged (contract 0.4.0,
9 tools), one-command installer + project-scoped `.mcp.json`, and single-file
interactive HTML export v1. Wren side re-checked on the web today: v0.29.2
released 2026-08-05 (Databricks connector, CVE patches, Claude Code
configuration support) — no MCP tool-surface or sharing changes found since the
audit._

## Verdict: is Wren AI a competitor?

**Yes — the most credible open-source competitor in the set, and now a direct
one.** The 08-02 comparison framed Wren's agent-first pivot as a bet hermetic
hadn't answered. That's no longer true: both products now ship MCP servers, so
the comparison has moved from "chat app vs platform" to a head-to-head between
two MCP tool providers with opposite trust models. Wren's company-level pivot to
a tools+skills MCP posture (HEAD deleted the GenBI app; the repo is now an
"Open Context Engine for AI Agents") is also the strongest external validation
of hermetic's own agent-first thesis. Three facts frame the comparison:

1. **Different center of gravity: governance vs. analysis — unchanged.** Wren's
   core asset is the MDL semantic layer — Git-versioned models, relationships,
   metrics, row/column ACLs — compiled by a Rust/DataFusion engine that
   validates every generated query before execution. Hermetic's core asset is
   the analysis pipeline — sandboxed Python + SQL, Investigate decomposition,
   verification of every claimed number. Wren governs _what the SQL may say_;
   hermetic verifies _what the analysis actually found_.
2. **Agent-first is now shipped-vs-shipped.** Wren exposes 6 MCP tools through
   Wren Cloud (Enterprise plan, OAuth, per-user ACLs) plus an OSS engine-side
   MCP server with zero LLM calls. Hermetic ships 9 MCP tools (contract 0.4.0,
   merged to main) with a flagship `analyze` that runs the entire pipeline —
   code-gen → sandbox → dashboard → verification — as one tool call. The trust
   models diverge completely: Wren validates the _SQL_ against schema and ACLs;
   hermetic constrains by _authorship_ — what the host wrote gets hardened
   gates, what hermetic wrote gets the sandbox (§ MCP head-to-head).
3. **The teachability race and the distribution race both moved.** Wren's
   context layer (MDL + versioned `instructions.md` + skills) remains the
   closest living analog to hermetic skills and still wins on governed
   definitions. But hermetic closed its longest-standing product gap this week:
   single-file interactive HTML export — a self-contained, offline-forever
   3–11 MB artifact from every surface, including an `export_url` the MCP host
   hands to the user. Wren's sharing still requires served infrastructure
   (deployed GenBI apps on Vercel/Cloudflare, Cloud artifacts).

---

## Overview

| Category        | Hermetic                                                                     | Wren AI                                                                        |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Core Model**  | AI-first application + MCP tool provider: question → verified dashboard      | Governed GenBI platform pivoting to "Open Context Engine" + MCP for agents     |
| **Deployment**  | Self-hosted / local-first; MCP via `.mcp.json` or one-command installer      | Self-hosted OSS (Docker), Wren Cloud (SaaS), on-prem / air-gapped (commercial) |
| **Pricing**     | Open source (free), incl. full MCP surface                                   | OSS free (Apache 2.0); Cloud from $99/mo; **MCP gated to Enterprise Cloud**    |
| **Target User** | Analyst (or their coding agent) who wants verified answers, data stays local | Data team standardizing governed self-serve analytics for business users       |
| **AI Posture**  | Data plane stays local; host orchestrates, never authors executed code       | Metadata-first: LLM works from MDL semantic model; engine validates output SQL |
| **Status**      | Actively developed; MCP contract 0.4.0; 2,161 tests                          | Actively developed (~16.8k stars; v0.29.2 shipped 2026-08-05); company: Canner |

_Honesty note on the AI-posture row: hermetic's MCP addendum
(`specs/mcp-server-proposal-2026-08-04.md` §8) explicitly amends the old "model
never sees rows" invariant — `run_sql` returns rows to the host by design. The
standing claim is now "the data plane stays local; the control plane is the
host," which is architecturally honest and closer to Wren's metadata-first
framing than the 08-02 comparison was._

---

## MCP head-to-head — the new primary axis

Both products now answer the same question: _what does a coding agent get when
it connects?_

### Tool surfaces

| Surface            | Hermetic (contract 0.4.0)                                                                                                                           | Wren AI                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Tool count         | 9                                                                                                                                                   | 6 (Cloud MCP); OSS HEAD ships an engine-side MCP server (no LLM calls)                      |
| Tools              | `connect_source`, `get_schema`, `run_sql`, `analyze`, `run_analysis`, `verify_narrative`, `persist_dashboard`, `export_dashboard`, `list_sources`   | `list_projects`, `get_project_metadata`, `ask`, `generate_sql`, `run_sql`, `generate_chart` |
| Flagship           | `analyze`: full pipeline (code-gen → sandbox → dashboard) in one call; returns summary + cost + viewer link + `export_url` + `run_id`               | `ask`: end-to-end NL Q&A                                                                    |
| Host-authored work | Yes — host can write SQL (`run_sql`), Python (`run_analysis`), dashboards (`persist_dashboard`), each behind its own gate                           | Yes — host-authored SQL via `run_sql`, validated against MDL + ACLs                         |
| Verification tools | `verify_narrative` audits host prose against computed results                                                                                       | None                                                                                        |
| Capability model   | Per-source capability discovery (`supported_tools`/`unsupported_tools` per source type)                                                             | Per-project exposure, admin-designated                                                      |
| Errors / contract  | Closed 8-code error taxonomy; versioned contract (0.2.0 → 0.4.0 history) in the handshake                                                           | 31 banded `ErrorCode`s + 12 phases engine-side (per audit) — more mature                    |
| Observability      | `run_id` joins tool result ↔ audit line ↔ server logs ↔ `data/runs/`; progress notifications; audit log on by default (JSONL, credentials stripped) | Langfuse tracing; Cloud-side audit logs (commercial)                                        |
| Access / setup     | Free; project-scoped `.mcp.json` (zero-step in Claude Code) or `scripts/install-mcp.sh` one-command install                                         | Cloud MCP requires **Enterprise Cloud plan** + org-admin enablement + OAuth                 |

### Trust models — validate the SQL vs. constrain the author

| Dimension          | Hermetic                                                                                                                                                       | Wren AI                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Philosophy         | Authorship-based: host is "trusted to orchestrate, not trusted to author code"                                                                                 | Content-based: every SQL statement validated against MDL schema + ACLs                                |
| Host SQL           | Hardened read-only gate: write-keyword scan **anywhere** in the statement (closes Postgres DML-in-CTE), `EXPLAIN ANALYZE` rejection, multi-statement rejection | Dry-plan compile against semantic layer; per-user RLAC/CLAC server-side                               |
| Engine backstops   | Postgres `default_transaction_read_only=on`; ClickHouse `readonly=2` (with profile-conflict fallback)                                                          | Engine-imposed row limits; no local engine to backstop (remote execution)                             |
| Host Python        | `run_analysis` always sandboxed with `network: "deny"` — regardless of code content                                                                            | N/A — no code execution at all (a deliberate, smaller surface)                                        |
| Exfiltration proof | CI egress canary with positive control, run under both network policies, mutation-tested                                                                       | N/A                                                                                                   |
| Host dashboards    | `persist_dashboard` validation is **enforcing** (zod reject, nothing persisted) — unlike the warn-only web path                                                | Charts are engine/browser-rendered vega-lite (audit: silent empty-chart degradation on invalid specs) |
| Row/column ACLs    | No — single-user by design                                                                                                                                     | Yes, enforced per authenticated user over MCP — the enterprise-grade answer                           |

**Neither trust model subsumes the other.** Wren's is the right shape for
multi-tenant governance: deterministic validation plus per-user ACLs means an
org can hand MCP access to a hundred agents. Hermetic's is the right shape for
capability: it lets the host run arbitrary Python statistics — something Wren
categorically cannot offer — and contains it with sandbox + network-deny + a
CI-proven exfiltration canary rather than by forbidding it. Wren's weakness here
(per the 08-04 audit) is that its OSS v1 "SELECT-only" was prompt-level with no
AST gate and its public APIs shipped unauthenticated; its Cloud MCP fixes access
control by fiat (OAuth + Enterprise gating). Hermetic's weakness is that its
guards protect one user's warehouse from a misbehaving host — there is no
concept of _which_ user is asking.

### Adoption friction

Hermetic: `git pull` + open Claude Code in the checkout — the committed
`.mcp.json` auto-prompts; or one `install-mcp.sh` run for Claude Desktop (real
JSON merge, backup-first). Wren OSS: docker-compose multi-service bring-up + UI
onboarding + MDL modeling before first value; Wren Cloud MCP: paid Enterprise
plan + admin enablement. Wren's 0.29.2 "Claude Code configuration support"
(shipped today) shows they're working the same friction — worth re-checking
next refresh.

---

## Data Sources

Largely unchanged from 08-02 — Wren wins warehouse breadth (20+ connectors incl.
Oracle, SQL Server, Athena, Spark; v0.29.2 strengthened Databricks) plus
cross-source federation; hermetic wins file-based/local data and zero-setup. Two
updates:

| Feature                     | Hermetic                                                                                                | Wren AI                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Semantic model over sources | No — but cached introspection + **inferred** FK relationships now flow to MCP hosts on `connect_source` | Yes — MDL: **declared** models, relationships, metrics, cubes |
| Schema context for agents   | `get_schema` summaries per source; join graph rides the connect response                                | `get_project_metadata` serves the governed model              |

The honest contrast holds: **hermetic infers, Wren declares.** Inferred FKs are
free and instant but heuristic; MDL relationships are authored, versioned truth.
An agent planning a join gets a hint from hermetic and a guarantee from Wren.
(Known gap: hermetic's inferred join graph is only on the `connect_source`
response — a host re-attaching to an existing source via `get_schema` doesn't
see it yet.)

---

## AI / LLM Capabilities

Delta view — rows unchanged from 08-02 (multi-provider LLM, local LLM, NL-to-SQL
self-healing, failure recovery, cost tracking) are not repeated.

| Feature                         | Hermetic                                                                   | Wren AI                                                                 |
| ------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| NL to Python analysis           | Yes (generated + sandboxed; now also host-authored via MCP `run_analysis`) | No (SQL only)                                                           |
| Multi-step agentic analysis     | Yes (Investigate), now callable as one MCP tool (`analyze`)                | Partial (agent SDKs orchestrate; no built-in decomposition)             |
| Grounded narrative verification | Yes — and exposed to hosts as `verify_narrative`                           | No                                                                      |
| Pre-execution validation        | LLM critic (semantic, skill-rule) + enforcing spec/SQL gates on host input | Engine dry-plan (mechanical: schema + ACLs) — stronger for that class   |
| Agent / IDE integration         | **Yes — MCP server v1** (Claude Code/Desktop; any MCP host)                | Yes (Cloud MCP, CLI, LangChain + Pydantic AI SDKs, Cursor/Cline)        |
| Answer-quality eval harness     | No (audit's top recommendation — still open)                               | Yes — 5.5k-LOC offline eval framework (Spider/BIRD, execution accuracy) |

The 08-02 row "Agent / IDE integration: No (destination app)" is retired — that
was the single biggest scoreboard change of the week. Wren keeps two genuine
leads worth naming plainly: the eval framework (hermetic measures determinism,
not answer quality) and constrained decoding for LLM outputs.

---

## Teachability — MDL + instructions vs hermetic skills

Still the most strategically important section, now with a new consumer: the
MCP host. Both context systems are becoming _agent-facing_ — Wren markets the
whole company as an "open context layer" for agents; hermetic's skills shape
what `analyze` does when a host calls it.

The 08-02 table stands (unit of knowledge, retrieval, enforcement, executable
helpers, metric governance, live reload — no material changes on either side
this week). The standing summary also holds: **Wren governs definitions;
hermetic governs method.** Wren's MDL remains the stronger answer to "two
dashboards disagree on what revenue means"; hermetic's skills remain the only
mechanism in the landscape that catches "fluent, valid, methodologically wrong"
— reviewer rules plus tested `skill_lib` helpers imported into the sandbox.

What changed is leverage, not mechanism: a skill taught to hermetic now
improves every MCP host's `analyze` calls for free, and Wren's context layer
now feeds `get_project_metadata`/`ask` for every connected agent. The
teachability race is becoming a context-quality race between two agent
backends.

---

## Visualization, Distribution & Product Surface

| Feature                           | Hermetic                                                                                                                                                                                                                                                                                                             | Wren AI                                                                                                        |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Native chart types                | 57 (AI-selected); pivots; 3D/geo/ML families                                                                                                                                                                                                                                                                         | Standard BI set (Text-to-Chart, vega-lite)                                                                     |
| Multi-widget dashboards           | Yes (adaptive layout, cross-filtering)                                                                                                                                                                                                                                                                               | Yes (AI-generated, browser-side WASM)                                                                          |
| Document export                   | PDF, DOCX, PPTX, XLSX, PNG, Markdown/HTML/Slides                                                                                                                                                                                                                                                                     | Via served UI / GenBI apps                                                                                     |
| **Infra-free shareable artifact** | **Yes — single-file interactive HTML (v1, shipped 2026-08-05)**: self-contained, offline-forever, 3.2 MB standard / 11.4 MB full profile, Tier-2 interactivity (filter, cross-filter, drill, parameters), from web UI, CLI (`hermetic render --html`), and MCP (`export_dashboard` tool + `export_url` on `analyze`) | No — sharing requires served infrastructure                                                                    |
| Live multi-user sharing           | No                                                                                                                                                                                                                                                                                                                   | Yes — GenBI apps deployed to Vercel/Cloudflare (live URL), Cloud team artifacts, unlimited users on paid plans |
| Embedding in other products       | No                                                                                                                                                                                                                                                                                                                   | Yes (GenBI apps, SDKs — a product pillar)                                                                      |
| Scheduled runs                    | Yes (node-cron on saved dashboards)                                                                                                                                                                                                                                                                                  | Cloud/commercial feature                                                                                       |

The 08-02 verdict "Wren wins on distribution" now needs splitting in two.
**Live, multi-user, always-current distribution: still Wren** — a deployed
GenBI app serves fresh data to a whole team, which a frozen file cannot.
**Durable, infra-free, send-it-anywhere distribution: now hermetic** — one
`.html` that opens from `file://` forever, survives the sender's laptop being
off, and needs no Vercel account, no Wren Cloud, no recipient login. Wren has
no equivalent artifact story (re-verified today: docs describe deployed apps
and Cloud artifacts only). Known hermetic v1 limits, stated honestly: CSV-scale
data inlined at the dashboard's existing client grain; large/warehouse Parquet
snapshots (DuckDB-WASM) deferred to v2.

---

## Deployment, Privacy & Governance

| Feature                     | Hermetic                                                                                                          | Wren AI                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Self-hosted / air-gapped    | Yes (fully; Docker + local LLM)                                                                                   | Yes (OSS Docker; air-gapped is a marketed commercial deployment)                                          |
| Sandboxed code execution    | Yes — incl. host-authored code: always `--network none`, CI egress canary                                         | N/A (no arbitrary code — SQL only, engine-validated)                                                      |
| LLM context                 | Schema + stats for generation; data plane local, rows never leave host boundary except to the user's own MCP host | MDL + schema (metadata-first); results render engine-side                                                 |
| Multi-tenant / RBAC / RLS   | No                                                                                                                | Yes (RLAC/CLAC per authenticated user, incl. over MCP — commercial)                                       |
| Audit trail                 | Yes — MCP audit log on by default, sanitized, `run_id`-joinable                                                   | Yes — Cloud/commercial audit logs                                                                         |
| Engineering maturity signal | Principal-review hardening pass merged this week (PRs #95/#96); 2,161 offline tests, unconditional CI             | Rust-core discipline at HEAD (clippy `-D warnings`, sqllogictests); OSS v1 CI was label-gated (per audit) |
| Maintenance risk            | Low (active)                                                                                                      | Low-moderate (active, weekly releases; VC-backed, Cloud monetization)                                     |

Both remain private-by-architecture for different reasons, and each spent this
period reinforcing its own bet: Wren by putting per-user ACL enforcement in
front of its MCP endpoint, hermetic by proving containment (DML-in-CTE closure,
engine read-only backstops, mutation-tested egress canary) rather than
forbidding capability.

---

## Pricing

Unchanged structurally (see 08-02 table: Wren OSS free / Cloud $99–299/mo /
enterprise concurrent-session licensing; hermetic $0 + compute). One new
asymmetry matters: **the MCP surfaces sit at opposite ends of the paywall.**
Hermetic's full 9-tool surface is free OSS. Wren's hosted MCP requires
Enterprise Cloud with admin enablement (the OSS engine-side MCP server exists
but serves the semantic engine, not the full GenBI loop). For a solo analyst
wiring Claude Code to their data this week, the effective price gap is total.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **analysis, not just answers** — Python statistics, Investigate, verification of every number, now one MCP tool call away
- Your agent needs **execution depth**: host-authored Python in a network-denied sandbox, verified narratives, enforced dashboard specs
- You want a **durable artifact** — a single offline-forever HTML file you can email, not a URL that depends on infrastructure
- **Files are your data** (CSV, Excel, GeoJSON, planet-scale Parquet) and you want **zero setup** — no semantic model before the first question
- You need **method enforcement** (skills: reviewer rules + tested helpers) and **per-question cost transparency**
- You're a **solo analyst or small team**, no multi-user requirement

### Choose Wren AI when:

- You need **governed self-serve BI for a whole org** — one metric layer, per-user RLAC/CLAC (enforced over MCP too), audit logs, unlimited users
- Your data lives in **many warehouses** or needs **cross-source federation**
- You want **live shareable dashboards and embeddable GenBI apps** serving fresh data to a team
- You want **deterministic SQL validation** against a versioned semantic model rather than authorship-based containment
- You're standardizing **agent access at enterprise scale** — OAuth-fronted MCP, per-project exposure, admin control
- You need a **maintained open-source** platform with a commercial support path

### The Fundamental Difference

**Hermetic** is a private analyst any agent can now hire: full computational
depth in a sealed sandbox, every number verified, every dollar visible — and
the finished work leaves as a self-contained file that outlives every server.

**Wren AI** is a governed answer layer any agent can now query: business truth
encoded once in a versioned semantic model, mechanically enforced per user, at
org scale.

The 08-02 closing line said an org could plausibly run both. That's truer now —
and more literal: both are MCP servers, so one Claude Code session could attach
Wren for governed metrics and hermetic for deep-dive analysis and the artifact
to send. Wren remains the competitor to watch precisely because its company
pivot validated the thesis hermetic just shipped against.

---

## Sources

- Hermetic (in-repo, verified 2026-08-05): `docs/mcp.md` (9-tool table, trust model, sharing, observability) · `specs/mcp-server-proposal-2026-08-04.md` §8 addendum (v1 shipped, harness framing) · `specs/dashboard-distribution-2026-08-05.md` (HTML export v1 implemented) · `src/mcp/server.ts` (contract 0.4.0) · `src/lib/warehouse/sql-guard.ts` · `scripts/egress-proof.ts` · `.mcp.json` + `scripts/install-mcp.sh` · merge commits `121bd2b` (MCP v1), PR #96 (hardening, 2,161 tests at `c0222ab`)
- [WrenAI releases — v0.29.2, 2026-08-05](https://github.com/canner/WrenAI/releases) (Databricks, CVE patches, Claude Code configuration support; no MCP/sharing changes)
- [WrenAI MCP integration docs](https://docs.getwren.ai/cp/guide/integrations/wrenai-mcp) (6 tools, `cloud.getwren.ai/api/mcp`, Enterprise Cloud gating, per-user RLAC)
- [WrenAI repo — "Open Context Engine" repositioning](https://github.com/Canner/WrenAI) · [wren-engine merged into WrenAI core/](https://github.com/Canner/wren-engine) · [GenBI apps (Vercel/Cloudflare deploy)](https://docs.getwren.ai/cp/guide/agentic/querying/genbi-apps) · [Wren AI pricing](https://www.getwren.ai/pricing)
- [Competitor engineering audit 2026-08-04](../audits/competitor-audit-wren-2026-08-04.md) · [Predecessor comparison 2026-08-02](./hermetic-vs-wrenai-2026-08-02.md)

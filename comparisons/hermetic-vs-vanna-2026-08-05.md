# Hermetic vs Vanna.ai — Competitive Feature Comparison

_Last updated: 2026-08-05_

_Refresh of `comparisons/hermetic-vs-vanna-2026-08-01.md`, four days on. The
Vanna side is unchanged — the OSS repo remains archived (read-only since
2026-03-29; a fresh check on 2026-08-05 found no unarchival, no new releases,
and no Vanna Cloud news), so the delta in this refresh is entirely one-sided.
What makes it worth writing anyway: since the predecessor, hermetic ran an
adversarial engineering audit of Vanna v2.0.2
(`audits/competitor-audit-vanna-2026-08-04.md`) and then **shipped its own
agent-facing execution surface** — the MCP server v1 (merged as PR #95, plus
today's single-file HTML export). The audit's anti-pattern catalog functioned
as a design checklist: every failure mode it documented in Vanna's shipped
tools now has a corresponding, CI-proven control in hermetic's. Section 4 is
the scorecard._

## Verdict: is Vanna a competitor?

**Same verdict as 2026-08-01 — closest architectural neighbor, not a product
competitor — but the contested ground has shifted under hermetic's feet, in
hermetic's favor.** The predecessor gave Vanna two structural wins: it was the
only way to put a chat-with-data agent _inside another surface_ (hermetic was
app-only), and its default-on audit logging was called "worth copying." Both
are now answered:

1. **Hermetic is now embeddable in an agent host.** The MCP server (nine
   tools; eight at v1 plus today's `export_dashboard`; `docs/mcp.md`) lets
   Claude Desktop, Claude Code, or any MCP client drive the full pipeline —
   one-command install (`scripts/install-mcp.sh`), embedded dashboard viewer,
   contract-versioned surface (0.4.0). This is _host_ embeddability, not
   Vanna's _product_ embeddability — see §6 for the honest split.
2. **The audit's warnings are shipped controls, not talking points.** The
   2026-08-01 comparison could only say hermetic's posture was _different_;
   the 2026-08-04 audit made the differences precise (Vanna v2 commits
   non-SELECT SQL, ships an unguarded `exec()`, runs no CI on PRs); and the
   MCP wave made hermetic's answers _testable claims with CI proofs_ —
   including a hardened read-only gate that rejects the exact DML-in-CTE
   class Vanna v2 executes, and an exfiltration canary that is
   mutation-tested.

Vanna's genuine merits from the predecessor all still stand: §7 keeps them.

---

## What changed since 2026-08-01

| Side         | Change                                                                                                                              | Evidence (in-repo)                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Vanna**    | Nothing. Repo still archived; no releases, no unarchival, no Cloud product news found in the 2026-08-05 check.                      | github.com/vanna-ai/vanna (read-only)                                  |
| **Hermetic** | MCP server v1 merged: 8 tools, flagship `analyze`, embedded viewer, error taxonomy, audit log, run-id joins, progress notifications | PR #95; `docs/mcp.md`; `src/mcp/server.ts` (contract history in-file)  |
| **Hermetic** | `export_dashboard` + `export_url`: contract 0.4.0, single-file interactive HTML from every surface (web, CLI, MCP) — shipped today  | `specs/dashboard-distribution-2026-08-05.md` (v1 IMPLEMENTED); c0222ab |
| **Hermetic** | Read-only SQL gate hardened: DML-in-CTE and `EXPLAIN ANALYZE` rejected; engine-level readonly backstops for Postgres and ClickHouse | `src/lib/warehouse/sql-guard.ts`, `postgres.ts`, `clickhouse.ts`       |
| **Hermetic** | Sandbox egress allowlist + permanent exfiltration canary, proven in CI on every push, mutation-tested                               | `lib/sandbox/egress.ts`; `scripts/egress-proof.ts`; `docs/mcp.md`      |
| **Hermetic** | One-command MCP installer + project-scoped `.mcp.json`                                                                              | `scripts/install-mcp.sh`; `.mcp.json`                                  |
| **Hermetic** | Codebase hardening pass (three phases): security, contracts, layering, coverage — 2161 tests green                                  | PR #96 (7a270fd, d8e018a)                                              |

---

## Overview (updated)

| Category        | Hermetic                                                                           | Vanna.ai                                                                     |
| --------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Core Model**  | AI-first application + MCP tool server: question → dashboard, host → RPC tools     | Developer framework: embed a text-to-SQL agent (`<vanna-chat>`) in your app  |
| **Deployment**  | Self-hosted / local-first; MCP host optional                                       | Self-hosted library (OSS, archived) or Vanna Cloud (hosted admin plane)      |
| **Pricing**     | Open source (free)                                                                 | OSS free (MIT); historical hosted tier ~$0.53/query; Vanna Cloud custom      |
| **Target User** | Analyst (app) or agent host (MCP); data stays local either way                     | Developer building a "chat with your database" feature for their org/product |
| **AI Posture**  | LLM never sees rows in the app; MCP boundary bounded, audited, honestly documented | Schema + RAG training context by default; 2.0 sends result summaries to LLM  |
| **Status**      | Actively developed (MCP v1 + HTML export shipped this week)                        | OSS repo archived 2026-03-29; commercial focus shifted to Vanna Cloud        |

---

## Scorecard: the Vanna audit as hermetic's design checklist

The 2026-08-04 audit catalogued what goes wrong when an agent is handed
execution tools without guards. Four days later, hermetic ships exactly that
kind of surface — an LLM host calling `run_sql`, `run_analysis`,
`persist_dashboard`. Each audit finding, and what hermetic's shipped MCP
server does about it:

| #   | Vanna anti-pattern (audit citation)                                                                                                           | Hermetic's shipped answer                                                                                                                                                                                                    | Proof                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | **v2 dropped the read-only SQL gate** — all 11 runners execute first, then shape the result; non-SELECT is committed (`sql_runner.py:88-108`) | `assertReadOnlySql` runs **before** any connector sees host-authored SQL, enforced at the connector factory                                                                                                                  | `src/lib/warehouse/sql-guard.ts`; `docs/mcp.md` tools table         |
| 2   | **First-token-only checking** — the class of gate (v1's sqlparse `SELECT` check) that DML-in-CTE and `EXPLAIN ANALYZE` walk straight through  | Gate hardened past its own first-keyword v1: write/DDL keywords rejected at any word boundary incl. inside CTEs; `EXPLAIN ANALYZE` rejected, plain `EXPLAIN` allowed                                                         | `src/lib/warehouse/__tests__/sql-guard.test.ts:42-62`               |
| 3   | **Safety in one layer only** (and the wrong side of execution)                                                                                | Engine-level backstops behind the gate: Postgres `default_transaction_read_only`; ClickHouse `readonly=2` — with a live-discovered fallback for already-readonly servers                                                     | `src/lib/warehouse/postgres.ts:27`, `clickhouse.ts:12-49` (b243384) |
| 4   | **Unguarded `exec()` of LLM code** with real globals, no timeout, silent fallback (`legacy/base/base.py:2095`)                                | Host-authored Python runs in Docker with `network: "deny"` — no egress regardless of code content; row-level datasets withheld from results                                                                                  | `docs/mcp.md` (`run_analysis`); sandbox executor tests              |
| 5   | **LLM-driven `pip install` + `run_bash` escaping the workspace jail** (`tools/python.py:125`)                                                 | No shell/install tools at all; networked runs (cloud Parquet) get only a bucket-scoped allowlist proxy on a routeless internal network — misses fail closed                                                                  | `lib/sandbox/egress.ts`; `docs/mcp.md` §allowlist                   |
| 6   | **Exfiltration unconsidered** (prompt-injected code could phone home)                                                                         | Permanent exfiltration canary in CI: an origin that must never receive a request, positive-controlled, checked under both policies, **mutation-tested** (widening the allowlist to private IPs is caught only by the canary) | `scripts/egress-proof.ts`, in CI every push                         |
| 7   | **README claims RLS that doesn't exist; migration guide teaches spoofable cookie auth** (`README.md:79`; `MIGRATION_GUIDE.md:41-46`)          | The opposite move: `docs/mcp.md` documents exactly what crosses the boundary and refuses to overclaim — bounded (row caps), visible (audit log), honestly described                                                          | `docs/mcp.md` §"What crosses the boundary"                          |
| 8   | **Credential exposure paths** (creds through app config; free-text identity)                                                                  | Credentials are structurally never tool arguments; warehouse configs, AWS env, and presigned query strings stripped from every response **and the audit log**                                                                | `docs/mcp.md` §cloud credentials; flow-coherence fix 3117303        |
| 9   | **Audit logging — Vanna's genuine strength**, default-on with sanitization (audit rec #4: adopt it)                                           | Adopted: `data/mcp-audit.jsonl` default-on, sanitized args, outcome, duration, error code, plus `run_id` joins to diagnostics/cost/logs that Vanna's log lacks                                                               | `docs/mcp.md` §observability; contract 0.3.0 notes                  |
| 10  | **Structured tool-args over parsed output** — the one v2 design the audit said to copy (rec #2)                                               | The MCP surface is typed tool-calls by construction; plus machine-readable failure: closed error-code set (`src/mcp/errors.ts`), flagged truncation, semver contract                                                         | `docs/mcp.md` §RPC hygiene; contract 0.4.0                          |
| 11  | **Quality infrastructure that doesn't run** — no CI on PRs, evals asserting nonexistent tool names, silent test skips                         | Proofs run unconditionally: replay-mode stdio proof of the real server (connect → analyze → viewer → audit), egress proof, 2161 tests — fail closed on every push                                                            | `scripts/mcp-proof.mjs`; CI config; PR #96                          |
| 12  | **Shipping the legacy attack surface in the new wheel** (11k LOC of v1 incl. the `exec()` path)                                               | One generation, one surface; the hardening pass exists precisely to avoid accreting a "legacy" layer                                                                                                                         | `specs/modularization-2026-08-01.md`                                |

**Still open, kept honest:** the audit's #1 recommendation — an answer-quality
eval harness runnable in CI — remains hermetic's gap. Vanna's eval scaffolding
was broken but at least expressed the intent; hermetic has replay/golden
determinism proofs, not accuracy evals. Unchanged from both audit and
predecessor.

---

## Embeddability, revisited — the honest split

The predecessor's flat "Vanna wins on embeddability" now needs splitting:

| Embedding target                                    | Hermetic                                                                                        | Vanna                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| An **agent host** (Claude Desktop/Code, MCP client) | Yes — nine tools, one-command install, embedded viewer, progress notifications, contract semver | No MCP surface (archived before MCP adoption became table stakes) |
| Your **own product's UI**                           | No — still no widget/component story                                                            | Yes — `<vanna-chat>` + FastAPI SSE; purpose-built                 |
| As a **Python library** in your codebase            | No                                                                                              | Yes — MIT library, one-method `SqlRunner` adapter, 44 extras      |

If the goal is "my agent can analyze my data without my data leaving home,"
hermetic now has the stronger story — and it is the story a 2026 evaluator
increasingly asks for first. If the goal is "a chat panel inside _our_ SaaS
product," Vanna (frozen or forked) is still the only one of the two with an
answer, and its extensibility recipes remain best-in-class per the audit.

---

## Sharing & distribution

New axis this refresh. Vanna's answer to "show this to a colleague" was
running an app: the v1 Flask/Streamlit apps (both archived) or the v2 FastAPI
server — self-hosted infrastructure either way, with the audit-documented CORS
`*` + credentials defaults. Hermetic's answer as of today is **no
infrastructure at all**: any analysis exports to one self-contained
interactive .html — spec, data, renderer, charts, fonts inlined; opens from
`file://`, offline, forever, with Tier-2 interactivity (filter, cross-filter,
drill). Available from the web export menu, `hermetic render --html`, and the
MCP `export_dashboard` tool / `export_url`
(`specs/dashboard-distribution-2026-08-05.md`). Governance floor: the file
carries only what the dashboard shows — `__`-internal state stripped, as-of
watermark, no tracking.

---

## What still stands from 2026-08-01

The predecessor's detailed tables (data sources, AI/LLM, teachability,
visualization, deployment, pricing) remain accurate — Vanna hasn't moved.
The durable points, kept on the record:

- **Vanna's RDBMS breadth still wins**: MySQL, Oracle, SQL Server, SQLite are
  Vanna-only. Hermetic still wins everywhere data lives outside a database.
- **Vanna's RAG training UX is still the best-known "teach it your schema"
  implementation** — and still suggestion-only, vs skills' enforcement +
  tested helpers.
- **Vanna's simplicity as a library is real**: `pip install`, `train()`,
  `ask()` is a gentler on-ramp than a Docker-sandboxed application, and the
  one-method adapter contract is the extensibility bar hermetic's Phase 2
  seams should meet (audit rec #3).
- **Multi-user enterprise plumbing** (RLS design intent, identity-aware
  tools, quotas) remains Vanna 2.0's differentiator on paper — with the
  audit's caveat that the shipped implementation doesn't yet enforce it.
- **The archival is still the strategic fact**: fork-or-Cloud is the choice a
  Vanna adopter inherits; hermetic remains the only member of this quadrant
  that is open source _and_ maintained _and_ local-first.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want a **finished analytics app** — question to dashboard, no code
- You want your **agent to have the tools**: MCP host support with a
  read-only-proven SQL gate, network-denied sandbox, audit log, and honest
  boundary documentation — the guardrails the Vanna audit found missing
- **Data privacy is structural** — blind execution in the app; bounded,
  visible, credential-free crossings via MCP
- You need **analysis beyond SQL** — Python, ML charts, Investigate,
  verification of every claimed number
- You want to **hand a colleague the result as one file**, not a hosted app
- You want an **actively maintained** open-source project

### Choose Vanna when:

- You're a **developer embedding chat-with-data into your own product's UI**
  — still the purpose-built option, via fork or Vanna Cloud
- You need **Q→SQL example training** to hit accuracy targets on a well-known
  schema, or the gentlest possible library on-ramp
- Your databases are **MySQL, Oracle, SQL Server, or SQLite**
- You need the **multi-user identity architecture** (and will implement the
  enforcement Vanna's shipped code leaves open)
- You accept the fork-or-Cloud tradeoff of the archived upstream

### The Fundamental Difference

**Hermetic** is an open-source analytics application that now also speaks
MCP: an analyst — or an agent — asks, the pipeline runs locally under proven
guards, and the result is a verified dashboard you can keep, share as a
single file, or audit line by line.

**Vanna** is (was) an open-source text-to-SQL framework a developer embeds in
their own product; the maintained version of that story lives in a hosted
cloud, and the shipped OSS code executes what the model writes with the
guards the audit found wanting.

Four days ago the comparison was posture vs posture. It is now shipped
control vs archived anti-pattern — with Vanna's real merits (library
simplicity, training UX, product embeddability, RDBMS breadth) intact and
unclaimed by hermetic.

---

## Sources

- [Vanna GitHub repo (archived 2026-03-29; re-checked 2026-08-05, still read-only)](https://github.com/vanna-ai/vanna) · [org repositories](https://github.com/orgs/vanna-ai/repositories) · [releases (none since archive)](https://github.com/vanna-ai/vanna/releases)
- Predecessor: `comparisons/hermetic-vs-vanna-2026-08-01.md` · Audit: `audits/competitor-audit-vanna-2026-08-04.md` (v2.0.2 @ `365d061`)
- Hermetic evidence: `docs/mcp.md` · `specs/mcp-server-proposal-2026-08-04.md` · `specs/dashboard-distribution-2026-08-05.md` · `src/lib/warehouse/sql-guard.ts` (+tests) · `scripts/egress-proof.ts` · `scripts/mcp-proof.mjs` · PRs #95, #96

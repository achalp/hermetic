# Hermetic as an MCP server — proposal & v1 implementation plan

**Date:** 2026-08-04
**Status:** v1 implemented (M1–M5, branch `mcp-server-v1`, 2026-08-04) —
tool surface + embedded viewer + hardening shipped per §3/§4; deviations:
`list_sources` added; `persist_dashboard`/`run_analysis` are CSV-source-only
in v1; consent flow realized as default-on audit + documented trust model
(docs/mcp.md) rather than interactive prompts
**Context:** Post-modularization Phase 1 (`specs/modularization-2026-08-01.md` §9).
An MCP server is "someone else's harness" — the third harness the modularization
explicitly anticipated. Competitive grounding:
`audits/competitor-audit-wren-2026-08-04.md` (Wren pivoted its whole company to
the tools+skills MCP posture) and `audits/competitor-audit-vanna-2026-08-04.md`
(the anti-pattern catalog for agent-facing execution tools).

---

## 1. The stress-tested premise

The naïve pitch — "hermetic lets Claude analyze your CSV" — is dead on arrival:
Claude Code already reads CSVs, writes pandas, retries errors, and emits plotly
HTML; hundreds of `run_sql` MCP connectors already exist. If usage ever shows
hermetic-MCP used mainly as a database connector, that is the **kill signal**
(see §6).

What survives adversarial scrutiny splits into foundational value (things no
host replicates by trying harder) and marginal value (things the host does
worse):

### Foundational

1. **An enforced data boundary, not a hoped-for one.** Freeform host analysis
   routinely pulls rows into model context (`head`, printed DataFrames).
   Hermetic's invariant — the model sees schema and computed aggregates, never
   rows — becomes a mechanically checkable tool contract: every response is
   schema, stats, or capped computed output. Warehouse credentials live behind
   the tool boundary instead of in env vars the agent can read. For
   policy-constrained data (PII, health, finance) this is the difference
   between "allowed to use the agent" and not.
   _Honesty note: creds are not yet keychain-encrypted at rest (Phase 2a item);
   the claim is "never in model context."_
2. **Durable, living artifacts.** Host output is a snapshot; hermetic's output
   is an analysis object — persisted spec + code + schema + source + artifacts,
   restorable, drillable, follow-up-askable, exportable, schedulable, and
   refreshable against the live source. Agent chats are write-only memory;
   hermetic is the shelf. No host will build this; it is a product, not a
   feature. The CLI's history-persist + `?restore=` link already proves the
   mechanism for a non-web harness.
3. **Scale via pushdown.** Multi-billion-row warehouse questions are a single
   tool call (pushdown, schema caching, capped materialization). Context
   windows and local pandas do not go there.

### Marginal but real

- **Governed sandbox** — Docker jail, memory watchdog, failure-hint retry, no
  host filesystem. Matters most under prompt injection, where hermetic's
  sandbox is categorically safer as the execution vector than host bash.
- **Schema intelligence** — domain detection, correlations, stats, capped
  samples; saves the tokens/turns hosts spend re-deriving per session.
- **`verify_narrative`** — grounding prose numbers against computed values
  (`lib/pipeline/grounding.ts`). Small, unique, credibility-building.
- **A real read-only SQL gate** — `assertReadOnlySql()`
  (`lib/warehouse/sql-guard.ts`) is code-level enforcement both audited
  competitors lack (Wren: prompt-level only; Vanna v2: commits non-SELECT).

### Stress-test verdicts folded in

- **Delegate-first, primitives-alongside.** Pure decomposition (host authors
  code/specs via primitives) forfeits hermetic's quality machinery — tuned
  prompts, purpose-driven compose, failure-hint retries — and quality failures
  get blamed on hermetic. The flagship tool is `analyze` (full tuned pipeline);
  primitives serve fine-grained control. The double-LLM cost objection is weak:
  the claude-cli transport bills the same subscription the host runs on.
- **Host-authored specs are v3, not v1.** An MCP host is precisely the
  untrusted spec author Phase 2a's hardening was written about; `validateSpec`
  must be enforcing (not warn-only) on that path before the catalog ships as a
  resource.
- **The artifact must not depend on `pnpm dev` running.** A dead
  `localhost:3000` restore link kills the flagship value; the MCP server must
  serve a viewer itself (§4, M3).
- **Adoption honesty.** Claude Code power users mostly won't switch off
  freeform pandas; the wedge is (a) Claude Desktop / claude.ai users — no local
  execution, built-in analysis means uploading data with size limits — and
  (b) warehouse-connected users on any host. Wren's pivot validates the MCP
  pattern; their "semantic layer" lane composes with hermetic's
  "execution + artifact" lane rather than competing.

## 2. Positioning

**"The analysis room for your agent."** Your agent asks; your data stays home;
the dashboard outlives the chat.

- vs. DB-connector MCPs: they move data into the conversation; hermetic moves
  **answers** into the conversation and keeps the analysis alive afterward.
- vs. host-native analysis: ephemeral and unbounded vs. durable and governed.
- vs. Wren: complementary — semantics in, execution + artifacts out.

## 3. Tool surface (v1)

Deliberately absent: bash, pip, filesystem browsing (the Vanna anti-patterns).
Every data-bearing response is capped (schema / stats / aggregates; sample
values bounded as in `extractSchema` today).

| Tool                | Contract                                                                                     | Pillar        |
| ------------------- | -------------------------------------------------------------------------------------------- | ------------- |
| `connect_source`    | file path or saved-connection id → `source_id` + schema summary                              | boundary      |
| `get_schema`        | `source_id` → rich schema (domains, correlations, stats, capped samples)                     | efficiency    |
| `analyze`           | `source_id`, question, purpose → tuned pipeline → dashboard URL + summary + capped artifacts | **flagship**  |
| `run_sql`           | `source_id`, sql → `assertReadOnlySql` → pushdown → capped results                           | scale         |
| `run_analysis`      | `source_id`, python → sandbox (network-deny default in MCP mode) → capped artifacts          | governed exec |
| `persist_dashboard` | `source_id`, spec → **enforcing** `validateSpec` → history entry + URL                       | artifact      |
| `verify_narrative`  | prose + run/artifacts → grounding report                                                     | trust         |

Cross-cutting defaults: audit log on by default (run events + tool name +
sanitized args — the one thing Vanna got right); per-source consent on first
`connect_source` to a new path/connection; all progress on MCP logging channel,
never mixed into results.

## 4. v1 implementation plan (against the real seams)

Harness pattern mirrors `src/cli/main.ts`: boot `installEnvConfig("snapshot")`
with default `hermeticPaths` roots and optional `configureLLMReplay`, then call
lib functions. New dependency: `@modelcontextprotocol/sdk` (stdio transport for
Claude Desktop/Code). New directory: `src/mcp/` (joins `src/cli/`, `src/harness/`
in the framework-free grep + ESLint groups; add to the CI "harness stays
framework-free" step and, if it imports beyond the allowed set, the isolation
check).

**M1 — server skeleton + read tools (days).**
`src/mcp/main.ts`: boot, register `connect_source` / `get_schema` / `run_sql`.
Seams: `parseCSV` → `extractSchema` → `storeCSV` (`lib/csv/*`) for files;
`createConnector` (`lib/warehouse/connector.ts:53`) + saved connections
(`lib/warehouse/persist-env.ts`) for warehouses; `runWarehouseQuery`
(`lib/warehouse/run-query.ts:84`) behind `assertReadOnlySql`
(`lib/warehouse/sql-guard.ts:34`). Source registry = a `stateNamespace` map of
`source_id → {csvId | connection}`. Proof: `pnpm mcp` + a scripted MCP client
round-trip in CI replay mode (same shape as the CLI proof).

**M2 — `analyze` + history link (days).**
Wrap `runPatchStream` + `runAskQuery` exactly as the CLI does; assemble via
`assembleSpecFromPatches`; persist via `persistHistoryEntry`; return
`{url, summary, cost}` where summary is extracted from the spec's narrative
elements and cost from the `/state/__cost` patch. Purpose parameter maps to
`lib/purpose-prompts`.

**M3 — embedded viewer (the adoption-critical piece).**
A minimal HTTP listener inside the MCP process serving a single-page viewer
that mounts `<SpecView>` on a `?restore=<id>` route, reading history entries
from `hermeticPaths.historyDir()`. Build as a small esbuild/vite bundle of
`spec/react` + the renderer closure (the isolation check proves this closure
compiles alone — this milestone cashes that guarantee). Fallback if the full
web harness is running: link to it instead.

**M4 — `run_analysis` + `verify_narrative` + audit log.**
`executeSandbox` (`lib/contracts/execution` options form) with an MCP-mode
default of network-deny (new `SandboxExecOptions` flag; today remote IO is
detected via `codeDoesRemoteIo` for timeout selection, not blocked — the block
is new, small, and this milestone's only real design work). `verifyGrounding`
(`lib/pipeline/grounding.ts`) over supplied prose + the run's artifacts.
Audit log: append-only JSONL under `hermeticPaths.runsDir()`.

**M5 — hardening pass before any public listing.**
Enforcing `validateSpec` on `persist_dashboard`; consent flow; tool-permission
doc; goldens for the MCP journey (record/replay already works — the middleware
is harness-agnostic); ratchet/isolation/CI wiring.

**v2/v3 (explicitly out of v1):** catalog-as-resource + host-authored specs
(gated on Phase 2a untrusted-spec hardening); `hermetic render` integration;
scheduled-refresh management tools; investigate-mode tool.

## 5. Effort

M1–M2 ≈ 2–4 days (the CLI proved the pattern). M3 ≈ 2–3 days (bundling, not
design). M4 ≈ 2–3 days (network-deny flag is the only new mechanism).
M5 ≈ 2 days. **Roughly two focused weeks to a hardened v1.**

## 6. Kill criteria & success signals

- **Kill:** telemetry shows `run_sql` dominant with `analyze`/`persist_dashboard`
  unused → the artifact thesis is wrong; hermetic-MCP is a commodity connector;
  stop investing (or spin the connector off and keep the app).
- **Success:** dashboards persisted per active user/week; restore-link
  click-through; `analyze` share of tool calls; repeat sources (same
  `source_id` across sessions = the "shelf" is being used).

## 7. Relationship to Phase 2

The MCP server resolves Phase 2's gate paradox: instead of waiting for a named
external consumer of npm packages, it makes every MCP-speaking agent a consumer
of the libraries _as they are_ — no publishing required. It also forces the
right subset of Phase 2a early (enforcing validation, trust model) while
deferring the rest (CSS distribution, packaging) until a package consumer
actually appears.

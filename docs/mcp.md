# The hermetic MCP server

Hermetic as a tool provider for MCP hosts (Claude Desktop, Claude Code, any
MCP-speaking agent): **your agent asks; your data stays home; the dashboard
outlives the chat.** Design and rationale:
`specs/mcp-server-proposal-2026-08-04.md`.

## Setup

One command — detects Claude Desktop / Claude Code, asks, writes the config
(JSON-merged with a backup; other servers preserved), builds the viewer:

```bash
./scripts/install-mcp.sh
```

`./start.sh` offers the same step automatically when it detects a Claude
install. Claude Code needs nothing even without the installer: this repo
ships a project-scoped `.mcp.json`, so opening `claude` in the checkout
prompts to enable the server.

Manual config, if you prefer (`pnpm -C` pins the working directory in the
command itself — `claude mcp add-json` drops a `cwd` field, and Desktop
support for one varies):

```jsonc
// Claude Desktop (claude_desktop_config.json) or Claude Code user scope
{
  "mcpServers": {
    "hermetic": {
      "command": "pnpm",
      "args": ["--silent", "-C", "/path/to/hermetic", "mcp"],
    },
  },
}
```

Prerequisites: `pnpm install` in the checkout; Docker with the sandbox image
(`docker build -t hermetic-sandbox ./docker/sandbox/`); your usual LLM
provider config for the `analyze` tool (same as the web app — including the
claude-cli transport, which bills your Claude subscription). Build the
embedded dashboard viewer once:

```bash
pnpm mcp:build-viewer
```

## Tools

| Tool                                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                          | Boundary guarantees                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `connect_source`                                                         | Attach a source → `source_id` + schema summary. `path`: .csv, .xlsx (`sheet` for multi-sheet), GeoJSON, .parquet file or folder (Hive auto-detected). `url`: cloud Parquet (s3/https/gs, incl. partitioned prefixes). `connection_id`: saved warehouse                                                                                                                                | No raw rows, no credentials in any response                                                                               |
| `get_schema`                                                             | Rich schema: column stats, detected domain, correlations                                                                                                                                                                                                                                                                                                                              | Aggregates only; row-linked samples are structurally unreachable                                                          |
| `analyze`                                                                | **Flagship.** Full hermetic pipeline (code-gen → sandbox → dashboard), persisted; returns summary + cost + link                                                                                                                                                                                                                                                                       | Data and compute stay local; host sees narrative + aggregates                                                             |
| `analyze_start` / `analyze_status` / `analyze_result` / `analyze_cancel` | The same pipeline as a **background job**: start returns `{job_id}` in milliseconds; status **long-polls** (blocks until the stage changes, default 45s); result returns the full analyze payload; cancel maps to the run-stop lever. For hosts that cancel long tool calls — Claude Desktop chat enforces a hard ~4-minute cap with no progressToken, while real analyses run longer | Same guarantees as `analyze`; results kept ~30 min after completion                                                       |
| `run_sql`                                                                | Read-only SELECT against a warehouse (pushdown; billions of rows)                                                                                                                                                                                                                                                                                                                     | `assertReadOnlySql` **before** execution; row-capped results                                                              |
| `run_analysis`                                                           | Host-authored Python in the Docker sandbox                                                                                                                                                                                                                                                                                                                                            | `--network none` enforced regardless of code content; row-level datasets withheld                                         |
| `verify_narrative`                                                       | Trace every data-like number in prose to computed values                                                                                                                                                                                                                                                                                                                              | Reports untraceable figures before the user sees them                                                                     |
| `persist_dashboard`                                                      | Persist a host-authored spec as a viewable analysis                                                                                                                                                                                                                                                                                                                                   | **Enforcing** catalog validation — invalid specs rejected                                                                 |
| `export_dashboard`                                                       | A persisted dashboard as ONE self-contained interactive .html file (share/send/open offline)                                                                                                                                                                                                                                                                                          | File contains only what the dashboard shows — same aggregates, no raw datasets beyond spec state, `__`-internals stripped |
| `list_sources`                                                           | Sources connected this session                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                         |

## Knowing what a source supports

`connect_source`, `get_schema`, and `list_sources` all return a capability
block, so the host never has to discover restrictions by being refused:

```json
{
  "source_type": "cloud-parquet",
  "supported_tools": ["get_schema", "analyze", "verify_narrative", "persist_dashboard"],
  "unsupported_tools": {
    "run_analysis": "cloud reads need network; host-authored code runs with networking denied — use analyze",
    "run_sql": "run_sql targets warehouse connections — use analyze for cloud Parquet"
  }
}
```

`source_type` is the meaningful flavor (`csv`, `cloud-parquet`,
`local-parquet`, `warehouse`); `kind` is only the storage class, so three
different source types report `kind: "csv"`.

## The dashboard link

`analyze`/`persist_dashboard` return a `dashboard_url` served by an **embedded
viewer** inside the MCP process (loopback-only, default port 4848) — the link
works with nothing else running. It renders the same `<SpecView>` the web app
uses: drill-downs and interactivity included.

- `HERMETIC_MCP_VIEWER_PORT` — preferred port (falls back to an ephemeral one).
- `HERMETIC_MCP_VIEWER=off` — disable the embedded viewer.
- `HERMETIC_MCP_VIEW_BASE=http://localhost:3000` — point links at the full web
  app instead (same entries, full app chrome + export menu).

Entries also appear in the web app's History page — the stores are shared when
both run from the same checkout.

### Inline dashboards (MCP Apps)

Hosts that negotiated the [MCP Apps extension](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
(`io.modelcontextprotocol/ui` — Claude Desktop, VS Code, Goose) render the
dashboard **inside the chat window** instead of behind the link:

- The server pre-declares `ui://hermetic/dashboard` — the data-less
  standard-profile viewer (~3 MB, fully self-contained; the host's default
  CSP blocks all external requests and nothing in the template makes any).
- `analyze` and `persist_dashboard` point at it via `_meta.ui.resourceUri`,
  and return the renderable spec as `structuredContent`. Per the extension,
  hosts deliver `structuredContent` to the iframe only — it is **not** added
  to model context, so the model-visible JSON stays exactly the text-block
  contract below.
- Capability-gated both ways: a text-only host never receives
  `structuredContent`, and a ui-capable host that never reads the template
  pays nothing. Heavy chart families (3D/geo/finance) show an
  "open the full dashboard" tile inline — `dashboard_url` still carries the
  complete view.

### Declared findings (manifest)

When `findings.mode` is `"on"` (the default; `"shadow"` collects without
shipping and `"off"` disables — runtime-config), `analyze`/`analyze_result` responses carry a
`findings` envelope — `{ manifest_version, findings: [...] }` — plus a
`findings_truncated` flag when the response cap (50 entries / 8 KB) trimmed
it. Each entry: `name`, `definition`, `dtype`, optional `unit`/`tags`/
`method`, `value`, optional `derived_from_findings`/`derived_from_columns`,
`code_ref` ("script.py:<line>" into the generated analysis code), and
`redeclarations`. `verify_narrative` ships the same manifest as
`structural_checks` with an explicit caveat string.

**Contract stability:** the GRAMMAR (envelope, entry field names,
`manifest_version`) is stable and bumps semver; the `dtype`/`tags`
vocabulary is OPEN by design — rely on structure, never on a dtype enum.
These are structural checks, not truth verification: definitions and values
come from the analysis code (inspectable at `code_ref`), unreviewed for
correctness. Entries persisted before 2026-08 have no manifest.

### Sharing a dashboard

`analyze` also returns an `export_url` beside `dashboard_url`: the same
entry as a **single self-contained .html download**
(`/api/export/<history_id>` on the embedded viewer; the viewer page has a
matching Download button). The `export_dashboard` tool writes that file
server-side instead — to `data/exports/<history_id>.html` or an absolute
`out_path` — and reports which bundle it inlined and the resulting size, so
the host can hand the user a file to drop in Slack, email, or a shared
drive. The file is offline-forever and carries full Tier-2 interactivity;
design and size budget: `specs/dashboard-distribution-2026-08-05.md`.

## Cloud sources and credentials

Cloud Parquet URLs are read over the network by DuckDB inside the sandbox —
nothing is downloaded to disk, and multi-billion-row partitioned datasets
work under the pipeline's scan budget. **Credentials are never tool
arguments** (a secret passed as an argument would flow through the host
model's context). Private buckets authenticate from the MCP server's own
environment, set in the host config:

```jsonc
"hermetic": {
  "command": "pnpm", "args": ["--silent", "mcp"], "cwd": "/path/to/hermetic",
  "env": { "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…" }
}
```

Public buckets (e.g. Overture) need nothing. The same policy is why new
warehouse connections can't be created via MCP — save them once in the web
app, then use `connection_id`.

## Architecture: the host is a harness

Hermetic is a set of libraries composed by interchangeable harnesses — the
Next.js app, the CLI, and now an MCP host. The tools are **RPC into those
libraries**; the host model plays the role `page.tsx` plays for the web app or
`main.ts` plays for the CLI: it decides what to call and in what order.

That framing sets the trust model precisely. A harness is trusted to
orchestrate — hermetic does not second-guess what data a harness asks for,
here any more than it does for the browser. What differs is that this
harness's _logic_ is an LLM's runtime decisions rather than audited code, and
its context may carry injected instructions. So the guards sit on
**authorship**, not on data:

- SQL the host writes passes `assertReadOnlySql` before any connector sees it.
- Python the host writes runs under `network: "deny"` — no egress at all,
  whatever the code looks like — while hermetic's own generated code gets the
  heuristic "auto" policy (and, for cloud sources, a bucket-scoped allowlist).
- Specs the host writes are validated ENFORCING; hermetic-composed specs keep
  the app's warn-only policy.

## What crosses the boundary — and what that means

**The data plane stays local**: files, the sandbox, warehouse connections,
persisted dashboards, and the viewer never leave your machine. **The control
plane is the host** — and everything a tool returns crosses into it.

If your host is a cloud assistant, that means analysis results — aggregates,
the chart series behind them, and any rows you requested via `run_sql` or
`run_analysis` — enter that provider's context. That is a property of
connecting a cloud host to your data, not something hermetic can undo by
withholding: a host that needs rows can always ask for them explicitly.
Hermetic's job is to keep it bounded, visible, and honestly described.

- **Bounded**: every row-bearing response is capped (`run_sql` 200 default /
  1000 max; 100 rows per chart series; `results` 20k chars in `run_analysis`;
  sandbox stderr 600 chars). Row-level `datasets` are never returned — they
  exist for the dashboard, which renders locally.
- **Visible**: every call is recorded in `data/mcp-audit.jsonl` with
  sanitized arguments, so you can see exactly what was asked for and when.
- **Never crossing, on any path**: credentials. Warehouse configs, AWS
  environment, and presigned-URL query strings are stripped — including from
  the audit log.

For a stricter posture, run a local-model MCP client: nothing leaves the
machine at all, and the libraries behave identically.

### RPC hygiene

An RPC surface owes its caller machine-readable failure and truncation
signals, not prose to parse:

- **Error codes** — every error response is `{ error, code }`, with `code`
  from a closed set (`src/mcp/errors.ts`): `unknown_source`,
  `source_expired`, `unsupported_source`, `invalid_input`, `sql_rejected`,
  `spec_rejected`, `execution_failed`, `internal`. A host that sees
  `source_expired` can re-attach and retry without a human reading the
  message. The audit line carries the same code.
- **Flagged truncation** — schema responses report `truncated_columns`
  (and warehouses `truncated_tables`) alongside the true counts; nothing
  is silently capped.
- **Contract version** — the initialize handshake and `list_sources`
  report the surface's semver (`contract_version`), bumped MINOR for
  additive response fields, MAJOR for anything a host could break on.
- **Joinable runs** — `analyze` returns the pipeline `run_id`, and the same
  id is stamped into the call's audit line — the join key to
  `data/runs/<run_id>/`, the diagnostics JSONL, the cost row, and the
  server logs (every log line carries it). Contract 0.3.0.

### How the bucket-scoped allowlist works

A networked remote-source run never gets open internet: the analysis
container joins an INTERNAL Docker network with no outbound route, and its
only door is a hermetic-owned allowlist proxy that forwards exclusively to
the hosts derived from the source URL + creds (`lib/sandbox/egress.ts`).
HTTPS passes through as CONNECT tunnels, so certificates still validate
against the real host; anything that misses the proxy fails closed against
the routeless network. Matching is exact hostname, case-insensitive; ports
are not restricted (bucket endpoints are distinguished by host, and a
port-restricted allowlist would break S3-compatible endpoints on
non-standard ports).

## Watching what the server is doing

| What                                                             | Where                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Every tool call (sanitized args, outcome, duration, errors)      | `data/mcp-audit.jsonl` — `tail -f data/mcp-audit.jsonl \| jq -c '{ts,tool,outcome,durationMs}'` |
| Live sandbox execution                                           | `docker ps \| grep hermetic-sandbox` (a container exists only while code runs)                  |
| Egress decisions during a cloud-source run                       | `docker logs <hermetic-egress-gw-…>` — one line per allowed/denied host                         |
| Server stderr (startup, replay mode, viewer port, pipeline logs) | the host's MCP logs: Claude Desktop → `~/.config/Claude/logs/`; Claude Code → `/mcp`            |
| Per-run diagnostics (generated code, attempts, failures)         | `data/runs/<runId>/`                                                                            |
| Finished analyses                                                | `data/history/` — or the History page in the web app                                            |
| Viewer alive?                                                    | `curl -s http://127.0.0.1:4848/api/health`                                                      |

A long `analyze` is normal: multi-minute runs are the pipeline generating
code, executing it in the sandbox, and composing the dashboard. `analyze`
emits **MCP progress notifications** throughout (`starting` → `estimating` →
`code_gen` → `executing: <phase>` with percent when the sandbox reports a
fraction → compose), so a host that requests progress can show live status
instead of a silent wait; hosts that don't request it pay nothing. The audit
line is written when the call finishes (with its duration), and `docker ps`
confirms live execution either way.

## Offline proof

CI drives the real server over stdio with replay fixtures
(`scripts/mcp-proof.mjs`): connect → schema → `analyze` (real sandbox, no
API key) → viewer serves the persisted dashboard → audit trail present.
Run locally: `HERMETIC_LLM_MODE=replay node scripts/mcp-proof.mjs`.

The egress allowlist is proven the same way (`scripts/egress-proof.ts`, in
CI on every push): allowed origin readable, non-allowlisted origin 403'd,
proxy bypass impossible — plus a permanent **exfiltration canary**, an
origin that must never receive a request, with a positive control proving
it is genuinely reachable from an unrestricted container first, so silence
means blocked rather than unreachable. The canary is checked under both
policies: host-authored code (`network: "deny"`) and allowlisted networked
code reading its permitted origin (the prompt-injection path).
Mutation-tested: disabling the allowlist, and separately widening it to
trust private-range IPs, both fail the proof — the second is caught ONLY by
the canary.

## Current limitations

- Excel workbook-relational mode (all sheets joined) is web-harness-only —
  MCP loads one sheet at a time; multi-sheet analysis via repeated
  connect_source.
- New warehouse connections cannot be created via MCP (by credential policy —
  see above); local Parquet/cloud URLs require the Docker runtime.
- `run_analysis` targets in-memory sources (CSV/Excel-sheet/GeoJSON — GeoJSON
  geometry is staged alongside the CSV); Parquet/cloud/warehouse sources
  analyze through `analyze` (mounted or scan-budgeted network reads the deny
  policy can't grant).
- `persist_dashboard` targets CSV-backed sources. The component catalog is not
  yet exposed as an MCP resource (deferred with the untrusted-spec hardening),
  so a rejected spec lists the valid component names in its error — but
  `analyze` remains the reliable way to produce a dashboard.
- `run_sql` results feed `verify_narrative` but cannot be charted or persisted
  directly; charting warehouse data goes through `analyze`.
- Concurrent `analyze` calls on ONE source are serialized (their computed
  artifacts share a per-source cache); different sources run in parallel.
- File/cloud `source_id`s SURVIVE server restarts: descriptors are written
  through to `data/mcp-sources.json` (never credentials) and rehydrated at
  boot from the on-disk bytes — necessary because some hosts (Claude Desktop
  chat) recycle the server between conversation turns. Credentialed
  cloud-parquet sources and warehouse connections do NOT rehydrate
  (credential policy; warehouse sockets also idle out after ~3h); affected
  tools then fail with a message naming the source, the cause, and the exact
  `connect_source` call that re-attaches it (a re-attach yields a NEW
  `source_id`).
- The catalog-as-resource (teaching the host to author specs natively) is
  deliberately deferred (spec §4, v3) behind the broader untrusted-spec
  hardening.

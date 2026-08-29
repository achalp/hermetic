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

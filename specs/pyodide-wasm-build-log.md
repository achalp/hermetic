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
- [ ] B. Combined strict-CSP browser execution (Pyodide from blobs, connect-src 'none')
- [ ] C. Rust Fetcher edge (real TLS/HTTP behind the decisions)
- [x] D. Tauri shell scaffold + cargo-build verified (sidecar packaging = 0c, deferred)
- [~] E. (partial) runtime auto-selection wired; browser transport wiring next
- [ ] E2. Wire the browser transport + the sidecar↔worker handoff into the app
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
3. [BLOCKED on E2] Launch the Tauri app, upload a CSV, ask a question → a dashboard
   renders with the analysis run in the webview worker (no Docker). This is the one
   step that needs E2 (the live handoff) built.
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

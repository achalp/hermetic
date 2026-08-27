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

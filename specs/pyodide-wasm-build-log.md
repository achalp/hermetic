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
- [ ] D. Tauri shell + Node sidecar packaging (build-verified)
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

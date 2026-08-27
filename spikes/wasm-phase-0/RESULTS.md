# Phase 0(a) results — Pyodide-in-Node feasibility + value gate

Spec: `specs/pyodide-wasm-sandbox-2026-08-26.md` §10. Run on Node v24, Pyodide
314.0.6 (numpy 2.4.6, pandas 3.0.2 — note: newer than the Docker-pinned numpy
2.2.4 / pandas 2.2.3; a version-drift item for parity testing).

## Verdict: **GO.** The value gate is green and compute-parity's core is exact.

### 1. Pyodide boots in Node — yes

- Cold-start (runtime boot): **~1.6 s**; + wheel load (numpy, pandas): **~1 s**
  (cached locally in `node_modules` after first fetch) → **~2.6 s first-run cold
  start**. This is the per-run latency the warm pool (Phase 2) amortizes (R3).
- RSS after boot ~170 MB; after wheels ~370 MB (host process, not the WASM heap).

### 2. `hermetic_runtime` p-value machinery — **bitwise-identical to CPython**

`node spikes/wasm-phase-0/boot.mjs` loads the real
`docker/sandbox/hermetic_runtime` into MEMFS and runs the exact p-value functions
(`_betainc_reg`, `_t_p_two_sided`, `_t_crit_95`, `_f_p`, `_kw_p`). **Max abs diff
= 0** across all cases — exact parity, no tolerance needed. This is pure-`math`
(no numpy), so the "verdicts depend on it" machinery is confirmed Pyodide-safe.

### 3. Memory ceiling (THE value gate) — covers normal datasets with room to spare

`node --expose-gc spikes/wasm-phase-0/memory-ceiling.mjs` runs the real
read_csv → groupby path at growing sizes:

|    CSV | rows | read+groupby | WASM-heap peak |
| -----: | ---: | -----------: | -------------: |
|   5 MB |  67k |       124 ms |         113 MB |
|  25 MB | 333k |       299 ms |         163 MB |
|  50 MB | 667k |       573 ms |         235 MB |
| 100 MB | 1.3M |       1.15 s |         406 MB |
| 200 MB | 2.7M |       2.24 s |         808 MB |
| 400 MB | 5.3M |       4.43 s |        1.45 GB |

- Cleanly handled up to **400 MB / 5.3M rows** — no failure; the wasm32 ~2 GB
  heap is the wall, reached around ~500–600 MB CSV at this ~3.6× heap:CSV ratio.
- **Implication for the §5 cap:** set the WASM input cap around **~250–300 MB**
  (leaving headroom under the wasm32 ceiling for intermediate frames + the
  groupby), which comfortably covers a non-technical user's spreadsheet/export.
  A normal personal dataset is single-digit to low-tens of MB — far inside this.

### 4. numpy/scipy tolerance parity — effectively exact

`node spikes/wasm-phase-0/scipy-tolerance.mjs` runs pearsonr/spearmanr/f_oneway/
kruskal + numpy aggregates on a fixed dataset in both engines. WASM (numpy 2.4.6)
vs native (numpy 2.2.4 + scipy 1.15.2 — **different versions AND BLAS**): **max
relative diff 1.7e-13** (most metrics bitwise-identical; worst is ANOVA p at
1.7e-13). The reviews' BLAS-divergence concern is real but negligible — the §9
parity gate can use a **tight ~1e-9 tolerance**, not a loose one. Compute-parity
is comprehensively de-risked (pure-math exact; numpy/scipy near-exact).

### 5. Sync/async bridge mechanism (Phase 1b-shim, spec §6-A) — feasible

`node spikes/wasm-phase-0/atomics-bridge.mjs` proves the hardest compute-side
unknown after the memory ceiling: a **synchronous** Python-side call (like
`duckdb.sql(q).df()`, no `await`) can block on `Atomics.wait` against a
`SharedArrayBuffer` while an **async** engine (standing in for DuckDB-WASM) runs a
Promise off-thread and `Atomics.notify`s — result delivered synchronously, 20ms
round-trip. So the sync/async impedance mismatch is **bridgeable**; remaining
integration = real DuckDB-WASM in the engine worker + the browser COOP/COEP infra
(a 0(b) item) + Pyodide's Python↔JS FFI wiring. The mechanism itself is proven.

## What this de-risks / what's still open

- De-risked: the fatal "physics" question — WASM can hold and analyze real
  datasets. The no-Docker value proposition holds.
- Still Phase-0: 0(b) boundary/transport/COOP-COEP + escape suite; 0(c) sidecar
  packaging; 0(d) Rust-egress stub. And numpy/scipy **tolerance** parity (BLAS
  differs native-vs-WASM) — characterize next; the pure-math core is already exact.
- Note: these spikes use `pyodide.FS` (MEMFS) directly and NODEFS is never
  mounted — consistent with the §7 "no host FS" boundary.

/**
 * The WASM sandbox subsystem's INTERNAL SEAMS — the interfaces each remaining
 * phase implements, so the work parallelizes against fixed boundaries instead of
 * a moving target. Types only (no runtime code); the spec section that owns each
 * seam is cited so an implementer knows the contract's source of truth.
 *
 * Dependency rule for the wasm/ module (enforced by scripts/isolation-check.mjs):
 * it may depend on @/lib/contracts/* and its own files ONLY — never Next, never
 * the app, never the docker executor. Untrusted-execution glue must not reach the
 * rest of the server.
 */
import type { ExecutionResult, AdditionalFile } from "@/lib/contracts/execution";

/** Common shape of every executor entrypoint — Docker and wasm alike. */
export type ExecuteFn = (
  csvContent: string,
  code: string,
  opts: { additionalFiles?: AdditionalFile[]; geojsonContent?: string | null }
) => Promise<ExecutionResult>;

/**
 * Phase 1c-transport (spec §4a) — the sidecar↔webview handoff. The sidecar
 * NEVER calls the worker directly; it drives this transport, which relays over
 * `postMessage` through the main thread. `run` ships code + input bytes to the
 * worker and resolves with the validated result (see relay.ts). Implementations:
 * a Node worker_thread (CI/parity) and the browser main-thread relay (real UX).
 */
export interface WasmTransport {
  /** Deliver a run to the worker; resolves with the relayed, validated result. */
  run(input: WasmRunInput): Promise<ExecutionResult>;
  /** Wall-clock cap; the SUPERVISOR (not the worker) terminates on timeout (§7 T3). */
  readonly timeoutMs: number;
  dispose(): Promise<void>;
}

export interface WasmRunInput {
  code: string;
  /** Files pushed as bytes into the worker MEMFS (input.csv, step_N.csv, runtime). */
  files: AdditionalFile[];
  /** The run's authorized remote source id, set OUT-OF-BAND by the sidecar (§6a #2). */
  authorizedSourceId?: string;
}

/**
 * Phase 1b-remote (spec §6a) — the Rust-core egress proxy contract, expressed on
 * the JS side that talks to it. The worker can only REQUEST a fetch; the guard
 * (backed by the trusted core) decides. The allowlist is derived from the STORED
 * source URL, never the worker-supplied one; the worker's URL host must be a
 * member, its path is an opaque object key (§6a #1). Read-only GET; streaming
 * byte-cap; resolve-and-reject internal IPs; no cross-host redirects.
 */
export interface EgressGuard {
  /** Approve/deny a worker fetch request against the run's authorized source. */
  authorize(req: EgressRequest): EgressVerdict;
}

export interface EgressRequest {
  /** The run this request belongs to (matched against the sidecar-set authorization). */
  runId: string;
  /** The URL the worker wants fetched (host validated against the derived allowlist). */
  url: string;
}

export type EgressVerdict = { allowed: true; host: string } | { allowed: false; reason: string };

/**
 * Phase 1b-shim (spec §6) — the synchronous `duckdb.sql(q).df()` bridge over the
 * async DuckDB-WASM engine. The Python-side call blocks on SharedArrayBuffer +
 * Atomics.wait (proven in spikes/wasm-phase-0/atomics-bridge.mjs) while the engine
 * runs the query in a second worker. Needs COOP/COEP cross-origin isolation.
 */
export interface DuckDbBridge {
  /** Synchronous from Python's view; blocks until the async engine answers. */
  querySync(sql: string): DuckDbResult;
  dispose(): void;
}

export interface DuckDbResult {
  columns: string[];
  rows: unknown[][];
}

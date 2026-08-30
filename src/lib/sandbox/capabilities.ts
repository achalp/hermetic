/**
 * Per-runtime capability descriptor — the single registry of what each
 * sandbox runtime can enforce, modeled on warehouse/engine-descriptor.ts
 * (ARCH-12): an exhaustive Record, so adding a SandboxRuntimeId member
 * without declaring its capabilities is a type error.
 *
 * Replaces the four hand-rolled `rt !== "docker"` / `rt !== "e2b"` checks
 * that used to be scattered through the executeSandbox dispatcher, each with
 * its own inline rejection — a new runtime (or a new docker-only feature)
 * had to find and extend every one of them. Now: the dispatcher asks ONE
 * gate, and the docker-only options previously documented only in comments
 * are enforced by data.
 */
import type { SandboxRuntimeId } from "@/lib/constants";

export interface RuntimeCapabilities {
  /**
   * Bind-mounted local files and copied-in Parquet (`localMountPath` /
   * `inputParquetPath`) — needs host filesystem access to the container.
   */
  supportsMount: boolean;
  /**
   * `network: "deny"` — a HARD no-network guarantee (--network none). Only
   * enforceable where we control the container's network namespace; on other
   * runtimes we refuse rather than silently degrade the isolation.
   */
  supportsNetworkPolicy: boolean;
  /**
   * Remote cloud reads (s3://, https:// Parquet over httpfs) — needs the
   * extended large-data execution budget that only the Docker path provides;
   * elsewhere the same code just died at the default timeout and burned the
   * retry budget with a spurious "timed out" that never named the real cause.
   */
  supportsRemoteIO: boolean;
  /** Warm (reused) container fast path — E2B stays ephemeral. */
  supportsWarm: boolean;
}

export const RUNTIME_CAPABILITIES: Record<SandboxRuntimeId, RuntimeCapabilities> = {
  docker: {
    supportsMount: true,
    supportsNetworkPolicy: true,
    supportsRemoteIO: true,
    supportsWarm: true,
  },
  // Pyodide + DuckDB-WASM (optional Docker-free runtime). Its PRODUCTION executor
  // is the sandboxed webview worker (spec §4 Option B), whose isolation is
  // enforced by the exec-context CSP and PROVEN by the in-browser escape suite
  // (e2e/wasm-escape-suite.spec.ts) — so `supportsNetworkPolicy: true` is honest:
  // a local-data wasm run is isolated exactly as Docker's --network none is. The
  // Node-Pyodide executor is CI/parity-only and never handles user data (build
  // log D1). The remaining flags stay FALSE until their paths ship + test (build
  // log D2): supportsRemoteIO (the Rust egress fetch, §6a), supportsMount
  // (big-data Parquet), supportsWarm (the warm pool). Until then those runs
  // honestly route to Docker. See specs/pyodide-wasm-build-log.md.
  wasm: {
    supportsMount: false,
    supportsNetworkPolicy: true,
    supportsRemoteIO: false,
    supportsWarm: false,
  },
};

/** What a specific execution request needs from the runtime. */
export interface CapabilityNeeds {
  /** network: "deny" was requested. */
  networkDeny?: boolean;
  /**
   * The run reads LOCAL data only (no remote source / egress grant), so it must
   * execute OFFLINE — the same guarantee Docker gives via --network none. On a
   * runtime that can't enforce a network policy this can't be met, so the run is
   * rejected rather than executing the user's data with un-isolated network
   * (finding M3 — the implicit-offline invariant, distinct from an EXPLICIT
   * network:"deny" request).
   */
  networkIsolation?: boolean;
  /** A bind-mount or copied-in Parquet is involved. */
  mount?: boolean;
  /** The code does remote cloud IO (codeDoesRemoteIo). */
  remoteIo?: boolean;
}

/**
 * Per-capability rejection messages. Kept actionable but harness-neutral —
 * this layer serves the web app, the MCP server, and tests alike, so it names
 * the required runtime rather than a UI navigation path.
 */
const CAPABILITY_ERRORS: {
  need: keyof CapabilityNeeds;
  has: keyof RuntimeCapabilities;
  message: (rt: SandboxRuntimeId) => string;
}[] = [
  {
    need: "networkDeny",
    has: "supportsNetworkPolicy",
    message: () =>
      "network='deny' is only enforceable with the Docker sandbox runtime (--network none). " +
      "Refusing to run rather than silently degrade the isolation.",
  },
  {
    need: "mount",
    has: "supportsMount",
    // Narrowed in D25: a browsed local file/folder is no longer gated here — the
    // wasm path converts it host-side and DELIVERS it, so it never asks for a
    // mount. What still needs one is a copied-in Parquet (a materialized
    // warehouse pull), which has no delivery path yet.
    message: () =>
      "This source is handed to the sandbox as a mounted Parquet file, which only the " +
      "Docker sandbox runtime can do.",
  },
  {
    need: "remoteIo",
    has: "supportsRemoteIO",
    message: (rt) =>
      "Remote cloud data reads (s3://, https:// Parquet over httpfs) are only supported with " +
      "the Docker sandbox runtime — other runtimes cap execution at the default timeout, which " +
      `remote scans exceed. This requires the docker runtime; the active runtime is "${rt}".`,
  },
  // Last: the generic local-data-must-run-offline invariant, so the more
  // specific messages above (explicit deny / mount / remote IO) win first.
  {
    need: "networkIsolation",
    has: "supportsNetworkPolicy",
    message: (rt) =>
      `Network isolation (--network none) for local data is only enforceable with the Docker ` +
      `sandbox runtime; "${rt}" cannot guarantee it, so generated code could reach the network ` +
      `with your data in the sandbox. Refusing to run — switch to the Docker runtime in Settings ` +
      `for local-data analysis.`,
  },
];

/**
 * The one generic gate: the first capability the request needs but the
 * runtime lacks yields its rejection message; null means the runtime can
 * honor everything asked of it. Checked in declaration order, which preserves
 * the dispatcher's historical precedence (deny → mount → remote IO).
 */
export function unsupportedCapabilityError(
  rt: SandboxRuntimeId,
  needs: CapabilityNeeds
): string | null {
  const caps = RUNTIME_CAPABILITIES[rt];
  for (const { need, has, message } of CAPABILITY_ERRORS) {
    if (needs[need] && !caps[has]) return message(rt);
  }
  return null;
}

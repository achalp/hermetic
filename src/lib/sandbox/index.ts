import { executeSandbox as dockerExecutor } from "./docker-executor";
import { codeNeedsNetwork, codeDoesRemoteIo } from "./docker-utils";
import { logger } from "@/lib/logger";
import { RUNTIME_CAPABILITIES, unsupportedCapabilityError } from "./capabilities";
import { getWarmManager } from "./warm-sandbox";
import type { ExecutionResult, AdditionalFile, SandboxRunHooks } from "@/lib/contracts/execution";
export type { AdditionalFile };
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getStoredCSV } from "@/lib/csv/storage";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import { egressPolicyFor } from "./egress";
import { hermeticRuntimeFiles } from "./runtime-files";

/**
 * Options for a sandbox execution (modularization M4-4b — replaces the
 * 8-positional-parameter signature this dispatcher used to have, the exact
 * bug class the pipeline orchestrator documents fixing for runPipeline:
 * a swapped pair type-checked fine and failed at runtime).
 */
/**
 * The WASM runtime's executor, INJECTED by the harness (spec §4a, build log D1):
 * the browser-transport executor in the desktop app; a Node executor in CI. The
 * sandbox layer never imports it — the real executor delegates to the sandboxed
 * webview worker, so it is supplied like hooks/runId. Absent ⇒ a wasm run fails
 * cleanly (headless contexts have no browser worker).
 */
export type WasmExecutor = (
  csvContent: string,
  code: string,
  opts: { additionalFiles?: AdditionalFile[]; geojsonContent?: string | null }
) => Promise<ExecutionResult>;

export interface SandboxExecOptions {
  runtime?: SandboxRuntimeId;
  /** The WASM executor, injected by the harness (see WasmExecutor). */
  wasmExecutor?: WasmExecutor;
  geojsonContent?: string | null;
  additionalFiles?: AdditionalFile[];
  /** Enables the warm-container fast path (not for E2B). */
  csvId?: string;
  /** Bind-mount source for browsed local files (Docker only). */
  localMountPath?: string;
  /** Materialized Parquet copied into the container (Docker only). */
  inputParquetPath?: string;
  /**
   * Orchestration capabilities (stop signal, progress, container registry,
   * failure hints). The executors never import the run registry — the caller
   * supplies these (run-control's ambientSandboxHooks() inside pipeline/).
   */
  hooks?: SandboxRunHooks;
  /**
   * Owning run id, stamped on ephemeral Docker containers as a label
   * (docker-executor's hermetic.runId) so `docker ps`/inspect can attribute a
   * container to its run. Same injection rule as `hooks`: the sandbox layer
   * never imports run-context — the pipeline caller passes getRunId().
   */
  runId?: string;
  /**
   * Network policy (MCP M4). "auto" (default): the Docker path grants an
   * ephemeral networked container only when codeDoesRemoteIo() says the code
   * reads remote data; everything else runs under --network none. "deny":
   * NO network regardless of what the code looks like — for code authored by
   * an untrusted/external model, where the heuristic is an exfiltration
   * vector, not a convenience. Docker-only: other runtimes cannot enforce
   * it here and are rejected rather than silently degraded.
   */
  network?: "auto" | "deny";
  /**
   * Explicit egress allowlist for a networked run (internal network +
   * allowlist gateway — lib/sandbox/egress.ts). When absent, remote-source
   * runs derive it from the stored source URL; local-data runs get
   * --network none regardless.
   */
  allowedEgressHosts?: string[];
}

/**
 * The routing DECISION for a run — a PURE function of the request + its source,
 * extracted so the security-critical "which network mode" table is testable
 * without a docker daemon. executeSandbox() below only TRANSLATES a plan into
 * executor calls; every network/egress choice is made HERE.
 */
export type SandboxRoutePlan =
  | { kind: "reject"; error: string } // capability gate
  | { kind: "docker-mount" } // local bind-mount / copied parquet → --network none
  | { kind: "docker-egress"; hosts: string[] } // remote source → L7 host-allowlist
  | { kind: "docker-deny" } // remote source, no derivable host → fail CLOSED
  | { kind: "warm" } // warm reused container (always --network none)
  | { kind: "ephemeral" } // ephemeral executor; docker gets --network none
  | { kind: "wasm" }; // the WASM runtime: run in the sandboxed webview worker (no Docker)

export interface SandboxRouteInput {
  runtime: SandboxRuntimeId;
  network: "auto" | "deny";
  /** localMountPath || inputParquetPath — LOCAL data, forced offline. */
  hasMount: boolean;
  remoteParquetUrl?: string;
  remoteCreds?: RemoteCreds;
  allowedEgressHosts?: string[];
  code: string;
  hasCsvId: boolean;
}

export function planSandboxRouting(i: SandboxRouteInput): SandboxRoutePlan {
  // A run with no remote source and no egress allowlist reads LOCAL data only,
  // so it will run OFFLINE (Docker: --network none). A runtime that can't enforce
  // that must reject rather than execute the user's data with un-isolated network
  // (finding M3, resolved fail-closed). Remote-source runs are separately gated by
  // remoteIo below (also docker-only), so this targets exactly the local case.
  const localDataOnly =
    !i.remoteParquetUrl && !(i.allowedEgressHosts && i.allowedEgressHosts.length);
  const capabilityError = unsupportedCapabilityError(i.runtime, {
    networkDeny: i.network === "deny",
    networkIsolation: localDataOnly,
    mount: i.hasMount,
    remoteIo: codeDoesRemoteIo(i.code),
  });
  if (capabilityError) return { kind: "reject", error: capabilityError };

  // The WASM runtime runs in the sandboxed webview worker (spec §4a). A wasm run
  // that clears the gate is necessarily LOCAL-only (its caps reject mount/remote —
  // capabilities.ts), so there is no Docker network decision to make: route it
  // straight to the wasm executor. (supportsRemoteIO/supportsMount flip on later —
  // build log D2 — at which point their branches land above this.)
  if (i.runtime === "wasm") return { kind: "wasm" };

  // Local data (a bind-mount or a copied-in Parquet) is FORCED offline,
  // regardless of what the generated code contains.
  if (i.hasMount) return { kind: "docker-mount" };

  // Network is a property of the SOURCE (finding 01): only an actual remote URL
  // or an explicit egress allowlist can GRANT it; codeNeedsNetwork can then only
  // NARROW that grant, never widen it (a local-CSV run whose injected code merely
  // contains a URL must NOT get egress while the user's data sits in /data).
  const sourceAllowsNetwork =
    i.network !== "deny" && (Boolean(i.remoteParquetUrl) || Boolean(i.allowedEgressHosts?.length));
  if (i.runtime === "docker" && sourceAllowsNetwork && codeNeedsNetwork(i.code)) {
    const policy = i.allowedEgressHosts
      ? ({ mode: "allowlist", hosts: i.allowedEgressHosts } as const)
      : egressPolicyFor(i.remoteParquetUrl, i.remoteCreds);
    // egressPolicyFor only returns mode "allowlist" with a NON-empty host list
    // (an empty derivation fails closed as "deny"), so `?? []` is unreachable —
    // it only satisfies the optional-`hosts` type.
    return policy.mode === "allowlist"
      ? { kind: "docker-egress", hosts: policy.hosts ?? [] }
      : { kind: "docker-deny" };
  }

  if (RUNTIME_CAPABILITIES[i.runtime].supportsWarm && i.hasCsvId) return { kind: "warm" };
  return { kind: "ephemeral" };
}

export function executeSandbox(
  csvContent: string,
  code: string,
  opts: SandboxExecOptions = {}
): Promise<ExecutionResult> {
  const { geojsonContent, csvId, localMountPath, inputParquetPath, hooks } = opts;
  const network = opts.network ?? "auto";
  const rt = opts.runtime ?? getActiveSandboxRuntime();
  const stored = csvId ? getStoredCSV(csvId) : undefined;

  const plan = planSandboxRouting({
    runtime: rt,
    network,
    hasMount: !!(localMountPath || inputParquetPath),
    remoteParquetUrl: stored?.remoteParquetUrl,
    remoteCreds: stored?.remoteCreds,
    allowedEgressHosts: opts.allowedEgressHosts,
    code,
    hasCsvId: !!csvId,
  });

  // Rejecting (not degrading) is the point — a silently weaker sandbox is an
  // isolation lie, and a silently shorter timeout burned the retry budget with
  // spurious "timed out"s.
  if (plan.kind === "reject") {
    return Promise.resolve({ success: false, error: plan.error, execution_ms: 0 });
  }

  // Every run carries the hermetic runtime package (tested helper sources the
  // prelude imports). Injected HERE — the single dispatch point — so all
  // runtimes and the warm paths get it identically.
  const additionalFiles = [...hermeticRuntimeFiles(), ...(opts.additionalFiles ?? [])];

  // The WASM runtime: hand off to the harness-supplied executor (browser worker
  // in the app; Node in CI — build log D1). No Docker involved. A context with no
  // executor configured (e.g. headless, no webview) fails cleanly rather than
  // silently falling through to Docker.
  if (plan.kind === "wasm") {
    if (!opts.wasmExecutor) {
      return Promise.resolve({
        success: false,
        error:
          "The WASM sandbox runtime is selected but no WASM executor is configured " +
          "in this context (it requires the desktop app's webview). Use the Docker runtime here.",
        errorKind: "user-config",
        execution_ms: 0,
      });
    }
    return opts.wasmExecutor(csvContent, code, { additionalFiles, geojsonContent });
  }

  if (plan.kind === "docker-mount") {
    return dockerExecutor(csvContent, code, {
      geojsonContent,
      additionalFiles,
      localMountPath,
      inputParquetPath,
      hooks,
      network: "deny",
      runId: opts.runId,
    });
  }

  if (plan.kind === "docker-egress") {
    // The container joins an internal network whose only route out is the L7
    // proxy, opened toward the derived source host ONLY (splice relay → near
    // direct-egress speed).
    return dockerExecutor(csvContent, code, {
      geojsonContent,
      additionalFiles,
      hooks,
      allowedEgressHosts: plan.hosts,
      runId: opts.runId,
    });
  }

  if (plan.kind === "docker-deny") {
    // A remote source with no derivable host fails CLOSED — reads die inside the
    // jail rather than escaping it.
    logger.warn("Remote source has no derivable egress host — network denied", { csvId });
    return dockerExecutor(csvContent, code, {
      geojsonContent,
      additionalFiles,
      hooks,
      network: "deny",
      runId: opts.runId,
    });
  }

  if (plan.kind === "warm") {
    const manager = getWarmManager(rt);
    if (manager) {
      return manager.execute(csvId!, csvContent, code, { geojsonContent, additionalFiles, hooks });
    }
    // No warm manager for this runtime → fall through to the ephemeral path.
  }

  // Ephemeral fallback. A run reaching here was NOT granted network above, so
  // Docker runs it under --network none. Docker is the only runtime.
  return dockerExecutor(csvContent, code, {
    geojsonContent,
    additionalFiles,
    hooks,
    network: "deny",
    runId: opts.runId,
  });
}

export { prepareWarmSandbox, warmupAllSandboxes } from "./warm-sandbox";

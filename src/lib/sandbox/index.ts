import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import { codeNeedsNetwork, codeDoesRemoteIo } from "./docker-utils";
import { logger } from "@/lib/logger";
import { RUNTIME_CAPABILITIES, unsupportedCapabilityError } from "./capabilities";
import { getWarmManager } from "./warm-sandbox";
import type { ExecutionResult, AdditionalFile, SandboxRunHooks } from "@/lib/contracts/execution";
export type { AdditionalFile };
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getStoredCSV } from "@/lib/csv/storage";
import { egressPolicyFor } from "./egress";
import { hermeticRuntimeFiles } from "./runtime-files";

/**
 * Options for a sandbox execution (modularization M4-4b — replaces the
 * 8-positional-parameter signature this dispatcher used to have, the exact
 * bug class the pipeline orchestrator documents fixing for runPipeline:
 * a swapped pair type-checked fine and failed at runtime).
 */
export interface SandboxExecOptions {
  runtime?: SandboxRuntimeId;
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

type SandboxExecutor = (
  csv: string,
  code: string,
  opts?: {
    geojsonContent?: string | null;
    additionalFiles?: AdditionalFile[];
    hooks?: SandboxRunHooks;
  }
) => Promise<ExecutionResult>;

const executors: Record<SandboxRuntimeId, SandboxExecutor> = {
  docker: dockerExecutor,
  e2b: e2bExecutor,
  microsandbox: microsandboxExecutor,
};

export function executeSandbox(
  csvContent: string,
  code: string,
  opts: SandboxExecOptions = {}
): Promise<ExecutionResult> {
  const { geojsonContent, csvId, localMountPath, inputParquetPath, hooks } = opts;
  const network = opts.network ?? "auto";
  const rt = opts.runtime ?? getActiveSandboxRuntime();

  // ONE capability gate replaces the per-feature `rt !== "docker"` rejections
  // this dispatcher used to scatter (see capabilities.ts): what the request
  // needs vs. what the runtime declares. Rejecting (not degrading) is the
  // point — a silently weaker sandbox is an isolation lie, and a silently
  // shorter timeout burned the retry budget with spurious "timed out"s.
  const capabilityError = unsupportedCapabilityError(rt, {
    networkDeny: network === "deny",
    mount: !!(localMountPath || inputParquetPath),
    remoteIo: codeDoesRemoteIo(code),
  });
  if (capabilityError) {
    return Promise.resolve({ success: false, error: capabilityError, execution_ms: 0 });
  }
  // Every run carries the hermetic runtime package (tested helper sources the
  // prelude imports, overriding its inline copies). Injected HERE — the single
  // dispatch point — so all runtimes and the warm paths get it identically.
  const additionalFiles = [...hermeticRuntimeFiles(), ...(opts.additionalFiles ?? [])];

  // Network is a property of the SOURCE, not the code (finding 01). A run may
  // only be granted a network namespace when it is backed by an actual REMOTE
  // source URL (or an explicit caller-supplied egress allowlist); the code
  // regex (codeNeedsNetwork) can then only NARROW that grant, never widen it.
  // Deriving the grant from `codeNeedsNetwork(code)` alone was an exfiltration
  // hole: a LOCAL-CSV run whose injected code merely contained a URL got full
  // bridge egress while the user's data sat in /data.
  const stored = csvId ? getStoredCSV(csvId) : undefined;
  const remoteParquetUrl = stored?.remoteParquetUrl;
  const sourceAllowsNetwork =
    network !== "deny" && (Boolean(remoteParquetUrl) || Boolean(opts.allowedEgressHosts?.length));

  // Both a bind-mount (browsed local files) and a copied-in Parquet (materialized
  // data) need the ephemeral Docker path — the warm container can't take a volume,
  // and a per-run copied file shouldn't leak across the shared warm container.
  // (The gate above guarantees rt === "docker" here.) These are LOCAL data by
  // construction, so network is FORCED OFF regardless of what the code contains.
  if (localMountPath || inputParquetPath) {
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

  // A remote-source run gets a fresh ephemeral container with restricted egress
  // instead of the (always --network none) warm path. Under "deny", or with no
  // remote source at all, this branch must not fire: network-looking code still
  // runs, but with no network — reads fail inside the jail instead of escaping it.
  if (rt === "docker" && sourceAllowsNetwork && codeNeedsNetwork(code)) {
    // Egress tiered by what the container HOLDS (egressPolicyFor): a
    // credential-less public source runs on an L3-blocked bridge (native
    // line-rate egress to the public internet, kernel drops packets aimed at
    // metadata/RFC-1918/loopback — nothing secret to exfiltrate, and the L7
    // proxy relay cost a 30x slowdown on planet-scale scans, run e1c88a71); a
    // source with stored creds gets the bucket-scoped L7 allowlist; creds with
    // no derivable host fail CLOSED. Warehouse sources never reach this branch
    // at all — they materialize host-side and run --network none.
    const policy = opts.allowedEgressHosts
      ? ({ mode: "allowlist", hosts: opts.allowedEgressHosts } as const)
      : egressPolicyFor(remoteParquetUrl, stored?.remoteCreds);
    if (policy.mode === "deny") {
      logger.warn("Remote source has creds but no derivable egress host — network denied", {
        csvId,
      });
    }
    return dockerExecutor(csvContent, code, {
      geojsonContent,
      additionalFiles,
      hooks,
      ...(policy.mode === "allowlist" ? { allowedEgressHosts: policy.hosts } : {}),
      ...(policy.mode === "l3blocked" ? { l3BlockedEgress: true as const } : {}),
      ...(policy.mode === "deny" ? { network: "deny" as const } : {}),
      runId: opts.runId,
    });
  }

  // Route through the warm manager when the runtime supports it (E2B stays
  // ephemeral — see RUNTIME_CAPABILITIES).
  if (RUNTIME_CAPABILITIES[rt].supportsWarm && csvId) {
    const manager = getWarmManager(rt);
    if (manager) {
      return manager.execute(csvId, csvContent, code, { geojsonContent, additionalFiles, hooks });
    }
  }

  // Fallback to ephemeral executors. A run reaching here was NOT granted
  // network above (no remote source, or it narrowed off), so Docker runs it
  // under --network none — the code regex may never re-open egress on a
  // local-data run from down here either.
  return (executors[rt] ?? dockerExecutor)(csvContent, code, {
    geojsonContent,
    additionalFiles,
    hooks,
    ...(rt === "docker" ? { network: "deny" as const, runId: opts.runId } : {}),
  });
}

export { prepareWarmSandbox, warmupAllSandboxes } from "./warm-sandbox";

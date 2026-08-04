import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import { codeNeedsNetwork, codeDoesRemoteIo } from "./docker-utils";
import { getWarmManager } from "./warm-sandbox";
import type { ExecutionResult, AdditionalFile, SandboxRunHooks } from "@/lib/contracts/execution";
export type { AdditionalFile };
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
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
   * Network policy (MCP M4). "auto" (default): the Docker path grants an
   * ephemeral networked container only when codeDoesRemoteIo() says the code
   * reads remote data; everything else runs under --network none. "deny":
   * NO network regardless of what the code looks like — for code authored by
   * an untrusted/external model, where the heuristic is an exfiltration
   * vector, not a convenience. Docker-only: other runtimes cannot enforce
   * it here and are rejected rather than silently degraded.
   */
  network?: "auto" | "deny";
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

  if (network === "deny" && rt !== "docker") {
    return Promise.resolve({
      success: false,
      error:
        "network='deny' is only enforceable with the Docker sandbox runtime (--network none). " +
        "Refusing to run rather than silently degrade the isolation.",
      execution_ms: 0,
    });
  }
  // Every run carries the hermetic runtime package (tested helper sources the
  // prelude imports, overriding its inline copies). Injected HERE — the single
  // dispatch point — so all runtimes and the warm paths get it identically.
  const additionalFiles = [...hermeticRuntimeFiles(), ...(opts.additionalFiles ?? [])];

  // Both a bind-mount (browsed local files) and a copied-in Parquet (materialized
  // data) need the ephemeral Docker path — the warm container can't take a volume,
  // and a per-run copied file shouldn't leak across the shared warm container.
  if (localMountPath || inputParquetPath) {
    if (rt !== "docker") {
      return Promise.resolve({
        success: false,
        error: "Parquet/local-file analysis is only supported with the Docker sandbox runtime.",
        execution_ms: 0,
      });
    }
    return dockerExecutor(csvContent, code, {
      geojsonContent,
      additionalFiles,
      localMountPath,
      inputParquetPath,
      hooks,
      network,
    });
  }

  // Remote cloud reads (s3://, httpfs) need the extended large-data timeout,
  // which only the Docker path budgets — on microsandbox/E2B the same code
  // just died at the 30s default and burned the retry budget with a spurious
  // "timed out" that never named the real cause. Reject with the cause.
  if (rt !== "docker" && codeDoesRemoteIo(code)) {
    return Promise.resolve({
      success: false,
      error:
        "Remote cloud data reads (s3://, https:// Parquet over httpfs) are only supported with " +
        "the Docker sandbox runtime — other runtimes cap execution at the default timeout, which " +
        "remote scans exceed. Switch to Docker in Settings → Sandbox Runtime.",
      execution_ms: 0,
    });
  }

  // The warm Docker container runs with --network none (shared, created
  // before any code is known). Code that reads remote data gets a fresh
  // ephemeral container with network instead of the warm path.
  // Under "deny" this branch must not fire: network-looking code still runs,
  // but with no network — reads fail inside the jail instead of escaping it.
  if (rt === "docker" && network !== "deny" && codeNeedsNetwork(code)) {
    return dockerExecutor(csvContent, code, { geojsonContent, additionalFiles, hooks });
  }

  // Route through warm manager when available (not for E2B)
  if (rt !== "e2b" && csvId) {
    const manager = getWarmManager(rt);
    if (manager) {
      return manager.execute(csvId, csvContent, code, { geojsonContent, additionalFiles, hooks });
    }
  }

  // Fallback to ephemeral executors
  return (executors[rt] ?? dockerExecutor)(csvContent, code, {
    geojsonContent,
    additionalFiles,
    hooks,
    ...(rt === "docker" ? { network } : {}),
  });
}

export { prepareWarmSandbox, warmupAllSandboxes } from "./warm-sandbox";

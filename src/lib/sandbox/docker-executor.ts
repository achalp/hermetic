import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile, SandboxRunHooks } from "@/lib/contracts/execution";
import { pythonNanPrelude } from "./prelude";
import { DOCKER_SANDBOX_IMAGE, LOCAL_MOUNT_PATH } from "@/lib/constants";
import {
  run,
  parseExecutionOutput,
  codeDoesRemoteIo,
  codeNeedsNetwork,
  lintScript,
  preflightLintError,
} from "./docker-utils";
import { sandboxMemoryRunArgs } from "./memory-budget";
import { sandboxHardeningRunArgs } from "./hardening";
import { streamExec } from "./stream-exec";
import { withWakeLock } from "@/lib/wake-lock";
import { logger, errMessage } from "@/lib/logger";
import { setupEgressNetwork, type EgressNetwork } from "./egress";
import { SANDBOX_RUNID_LABEL } from "./lifecycle";
import { SANDBOX_CONTAINER_PREFIX } from "@/lib/constants";

export interface DockerExecOptions {
  geojsonContent?: string | null;
  additionalFiles?: AdditionalFile[];
  localMountPath?: string;
  inputParquetPath?: string;
  hooks?: SandboxRunHooks;
  /** "deny" forces --network none even when the code looks like remote IO
   *  (see SandboxExecOptions.network — untrusted-author policy, MCP M4). */
  network?: "auto" | "deny";
  /** When the run IS granted network for a remote source, restrict egress to
   *  exactly these hosts via an internal network + allowlist gateway
   *  (lib/sandbox/egress.ts). The L7 proxy tier — the only egress tier for
   *  remote sources, public or credentialed. */
  allowedEgressHosts?: string[];
  /** Owning run id, stamped as a docker label (SANDBOX_RUNID_LABEL) so the
   *  container is attributable to its run from `docker ps`/inspect. Supplied
   *  by the pipeline caller — this layer never imports run-context. */
  runId?: string;
}

export async function executeSandbox(
  csvContent: string,
  code: string,
  opts: DockerExecOptions = {}
): Promise<ExecutionResult> {
  const { geojsonContent, additionalFiles, localMountPath, inputParquetPath, hooks } = opts;
  const start = Date.now();
  const id = `${SANDBOX_CONTAINER_PREFIX}${randomUUID()}`;
  let egress: EgressNetwork | null = null;

  // Whether the run touches large local Parquet or slow remote cloud data — kept
  // for logging/telemetry only. It NO LONGER bounds execution: we never impose a
  // timeout (a genuinely long analysis is allowed to take as long as it needs);
  // the run ends on completion or an explicit user Stop. See stream-exec.ts.
  const isLargeData = !!localMountPath || !!inputParquetPath || codeDoesRemoteIo(code);

  try {
    // 1. Create container (with optional bind-mount for browsed local files).
    //    `sleep infinity` — the container's own lifetime must not be a hidden
    //    self-kill either; it's torn down in the finally (or by the store
    //    sweeper if the process died).
    const runArgs = [
      "run",
      "-d",
      "--name",
      id,
      ...(await sandboxMemoryRunArgs()),
      ...sandboxHardeningRunArgs(),
    ];
    // Attribute the container to its run (forensics / lifecycle tooling).
    if (opts.runId) runArgs.push("--label", `${SANDBOX_RUNID_LABEL}=${opts.runId}`);
    // No network unless the code actually reads remote data — this is what
    // makes the sandbox isolation claim true for local-data analyses. The
    // image pre-bundles the DuckDB httpfs/spatial extensions, so offline
    // INSTALL/LOAD still works under --network none.
    // Network is granted only when the source earned it (index.ts) — signalled
    // here by the egress allowlist or plain remote-IO code. An explicit egress
    // allowlist forces network on even if the regex disagrees.
    const withNetwork =
      opts.network === "deny"
        ? false
        : codeNeedsNetwork(code) ||
          !!(opts.allowedEgressHosts && opts.allowedEgressHosts.length > 0);
    if (!withNetwork) {
      runArgs.push("--network", "none");
    } else if (opts.allowedEgressHosts && opts.allowedEgressHosts.length > 0) {
      // L7 allowlist tier: internal network + allowlist gateway. The container
      // has no route out except the proxy, and the proxy only opens toward the
      // derived source hosts — so it can't reach an attacker host, cloud
      // metadata, or private ranges. Short id: the gateway's container name
      // doubles as a DNS label (63-char limit), so the full id is too long.
      egress = await setupEgressNetwork(id.slice(-12), opts.allowedEgressHosts);
      runArgs.push("--network", egress.networkName);
      for (const [k, v] of Object.entries(egress.env)) {
        runArgs.push("-e", `${k}=${v}`);
      }
    }
    if (localMountPath) {
      runArgs.push("-v", `${localMountPath}:${LOCAL_MOUNT_PATH}:ro`);
    }
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "infinity");
    logger.debug("Docker: creating container", {
      id,
      hasMount: !!localMountPath,
      hasParquet: !!inputParquetPath,
      largeData: isLargeData,
      network: withNetwork,
    });
    await run("docker", runArgs, { timeoutMs: 15_000 });
    // Register with the caller's run registry so a user Stop can force-remove
    // this container (and the sweeper knows it's a live run, not an orphan).
    hooks?.onContainerStart?.(id);
    logger.debug("Docker: container created");

    // A materialized Parquet is copied IN with `docker cp` (binary-safe, and —
    // unlike a bind-mount — with NO dependency on Docker's host file-sharing
    // config, so it works no matter where the host file lives).
    if (inputParquetPath) {
      await run("docker", ["cp", inputParquetPath, `${id}:/data/input.parquet`], {
        timeoutMs: 120_000,
      });
    }

    // 2. Write data files. The primary input CSV is skipped when the data comes
    //    from a bind-mount or a copied-in Parquet. But geojson and additional
    //    files — including step-dependency frames like /data/step_1.csv — must
    //    ALWAYS be written: they live under /data/ (writable), and dependent
    //    sub-questions read them.
    if (!localMountPath && !inputParquetPath) {
      await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.csv"], {
        input: csvContent,
        timeoutMs: 15_000,
      });
    }

    if (geojsonContent) {
      await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.geojson"], {
        input: geojsonContent,
        timeoutMs: 15_000,
      });
    }

    if (additionalFiles && additionalFiles.length > 0) {
      for (const file of additionalFiles) {
        // Each file creates its own parent dir — paths now span /data/sheets,
        // /data/hermetic_runtime, /data/skill_lib, /data/user_lib.
        const safePath = file.path.replace(/'/g, "'\\''");
        const safeDir = safePath.slice(0, safePath.lastIndexOf("/")) || "/data";
        await run(
          "docker",
          ["exec", "-i", id, "sh", "-c", `mkdir -p '${safeDir}' && cat > '${safePath}'`],
          { input: file.content, timeoutMs: 15_000 }
        );
      }
    }

    // 3. Write script via stdin (with NaN-safety prelude)
    await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/script.py"], {
      input: pythonNanPrelude() + code,
      timeoutMs: 15_000,
    });
    logger.debug("Docker: script written");

    // 3b. Static undefined-name pre-flight (milliseconds) — catch a forgotten
    //     import BEFORE a multi-minute remote scan dies on a last-line NameError.
    //     Best-effort: a null result (checker couldn't run) means proceed.
    const lint = await lintScript(id).catch(() => null);
    const lintError = lint ? preflightLintError(lint) : null;
    if (lintError) {
      logger.info("Docker: pre-flight lint rejected script", {
        undefined: lint?.undefinedNames.map((u) => u.name),
        syntax: lint?.syntaxError?.message,
      });
      // No errorKind → ordinary retryable error: the retry loop re-generates with
      // the missing import added (not a timeout/oom/stopped control-flow case).
      return {
        success: false,
        error: lintError,
        execution_ms: Date.now() - start,
      };
    }

    // 4. Run script — STREAMED (no timeout), under a macOS wake lock so idle
    //    sleep doesn't drop the container's S3 connections mid-scan. Progress
    //    heartbeats on stdout surface live via run-control; a user Stop aborts
    //    the run's signal, which force-removes the container.
    logger.info("Docker: executing script", { largeData: isLargeData });
    const execResult = await withWakeLock(`sandbox:${id}`, () =>
      streamExec(id, { signal: hooks?.signal, onProgress: hooks?.onProgress })
    );

    if (execResult.aborted) {
      logger.info("Docker: execution stopped by user", { ms: Date.now() - start });
      return {
        success: false,
        error: "Analysis stopped.",
        errorKind: "stopped",
        execution_ms: Date.now() - start,
      };
    }

    // 5. Parse output. Log the OUTCOME symmetrically with the start line. Pass
    //    the host-captured live phase/config so an OOM that hard-killed the whole
    //    container (post-mortem file reads blank) still routes to phase-specific
    //    guidance instead of the generic pandas blob.
    const result = await parseExecutionOutput(
      id,
      start,
      String(execResult.exitCode),
      { lastPhase: execResult.lastPhase, duckdbCfg: execResult.duckdbCfg },
      hooks?.failureHints
    );
    logger.info("Docker: execution finished", {
      ms: Date.now() - start,
      success: result.success,
      ...(result.success ? {} : { errorHead: result.error.slice(0, 200) }),
    });
    return result;
  } catch (err) {
    const errorMsg = errMessage(err);
    logger.warn("Docker: execution threw", {
      ms: Date.now() - start,
      errorHead: errorMsg.slice(0, 200),
    });
    return {
      success: false,
      error: errorMsg,
      execution_ms: Date.now() - start,
    };
  } finally {
    // 6. Cleanup — always remove container + drop it from the live registry.
    hooks?.onContainerEnd?.(id);
    await run("docker", ["rm", "-f", id]).catch(() => {});
    if (egress) await egress.teardown();
  }
}

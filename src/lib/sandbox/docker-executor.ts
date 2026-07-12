import "server-only";
import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import {
  DOCKER_SANDBOX_IMAGE,
  SANDBOX_TIMEOUT_MS,
  LARGE_DATA_TIMEOUT_MS,
  LOCAL_MOUNT_PATH,
} from "@/lib/constants";
import { run, parseExecutionOutput, codeDoesRemoteIo, codeNeedsNetwork } from "./docker-utils";
import { sandboxMemoryRunArgs } from "./memory-budget";
import { withWakeLock } from "@/lib/wake-lock";
import { logger } from "@/lib/logger";

export async function executeSandbox(
  csvContent: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  localMountPath?: string,
  inputParquetPath?: string
): Promise<ExecutionResult> {
  const start = Date.now();
  const id = `hermetic-sandbox-${randomUUID()}`;

  // Large local Parquet (mount / copied-in) and slow remote cloud reads (s3://,
  // https:// via httpfs) both need the extended timeout. Computed up front so the
  // container is kept alive at least as long AND the value can surface on timeout.
  const isLargeData = !!localMountPath || !!inputParquetPath || codeDoesRemoteIo(code);
  const execTimeout = isLargeData ? LARGE_DATA_TIMEOUT_MS : SANDBOX_TIMEOUT_MS;

  try {
    // 1. Create container (with optional bind-mount for browsed local files).
    //    Keep it alive past the exec budget so a long run can't outlive its host.
    const containerLifetime = Math.ceil(execTimeout / 1000) + 60;
    const runArgs = ["run", "-d", "--name", id, ...(await sandboxMemoryRunArgs())];
    // No network unless the code actually reads remote data — this is what
    // makes the sandbox isolation claim true for local-data analyses. The
    // image pre-bundles the DuckDB httpfs/spatial extensions, so offline
    // INSTALL/LOAD still works under --network none.
    const withNetwork = codeNeedsNetwork(code);
    if (!withNetwork) {
      runArgs.push("--network", "none");
    }
    if (localMountPath) {
      runArgs.push("-v", `${localMountPath}:${LOCAL_MOUNT_PATH}:ro`);
    }
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", String(containerLifetime));
    logger.debug("Docker: creating container", {
      id,
      hasMount: !!localMountPath,
      hasParquet: !!inputParquetPath,
      execTimeout,
      largeData: isLargeData,
      network: withNetwork,
    });
    await run("docker", runArgs, { timeoutMs: 15_000 });
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
      await run("docker", ["exec", id, "mkdir", "-p", "/data/sheets"], { timeoutMs: 5_000 });
      for (const file of additionalFiles) {
        const safePath = file.path.replace(/'/g, "'\\''");
        await run("docker", ["exec", "-i", id, "sh", "-c", `cat > '${safePath}'`], {
          input: file.content,
          timeoutMs: 15_000,
        });
      }
    }

    // 3. Write script via stdin (with NaN-safety prelude)
    await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/script.py"], {
      input: PYTHON_NAN_PRELUDE + code,
      timeoutMs: 15_000,
    });
    logger.debug("Docker: script written");

    // 4. Run script. Held under a macOS wake lock (see wake-lock.ts): idle
    //    sleep mid-scan drops the container's S3 connections AND freezes the
    //    timeout timer, the signature behind every mid-run "network error".
    logger.info("Docker: executing script", { execTimeout, largeData: isLargeData });
    const execResult = await withWakeLock(`sandbox:${id}`, () =>
      run(
        "docker",
        [
          "exec",
          id,
          "sh",
          "-c",
          "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
        ],
        { timeoutMs: execTimeout }
      )
    );

    // 5. Parse output. Log the OUTCOME symmetrically with the start line —
    // execution previously ended silently, so a mid-run failure left no
    // server-side record of when the sandbox finished or how (the exact gap
    // that made the July-8 long-query failures undiagnosable from logs).
    const result = await parseExecutionOutput(id, start, execResult.stdout);
    logger.info("Docker: execution finished", {
      ms: Date.now() - start,
      success: result.success,
      ...(result.success ? {} : { errorHead: result.error.slice(0, 200) }),
    });
    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMsg.includes("timed out");
    const wallMs = Date.now() - start;
    // The timeout is a Node setTimeout, which only advances while awake. So on
    // a genuine timeout wall-time ≈ execTimeout; a wall-time far BEYOND the
    // budget means the timer was frozen — i.e. the machine slept mid-run — and
    // `wallMs - execTimeout` is roughly how long it was suspended. Report that
    // honestly instead of blaming a slow query (the July-8/9 failures were all
    // this: e.g. a 20-min budget "timing out" after 40.6 min of wall clock).
    const suspendedMs = isTimeout ? Math.max(0, wallMs - execTimeout) : 0;
    const likelySuspended = suspendedMs > 60_000;
    logger.warn("Docker: execution threw", {
      ms: wallMs,
      isTimeout,
      ...(likelySuspended ? { likelySuspended, approxSuspendedMs: suspendedMs } : {}),
      errorHead: errorMsg.slice(0, 200),
    });

    // On timeout, try to grab stderr for context on what was running. Include the
    // budget actually applied — the fast way to see whether the extended
    // (remote/large) timeout kicked in.
    let detail = errorMsg;
    if (isTimeout) {
      detail = likelySuspended
        ? `Execution was interrupted: the machine appears to have slept for ~${Math.round(suspendedMs / 60_000)} min during this run (${wallMs}ms wall vs a ${execTimeout}ms budget), which drops the sandbox's network and stalls the scan. Keep the machine awake and re-run — the app now holds a wake lock during execution, but it cannot override a closed lid.`
        : `Sandbox execution timed out after ${execTimeout}ms (largeData=${isLargeData}).`;
      try {
        const stderr = await run("docker", ["exec", id, "cat", "/data/stderr.txt"], {
          timeoutMs: 5_000,
        });
        if (stderr.stdout.trim()) {
          const lastLines = stderr.stdout.trim().split("\n").slice(-10).join("\n");
          detail += ` Last stderr:\n${lastLines}`;
        }
      } catch {
        // Container may already be gone
      }
    }

    return {
      success: false,
      error: detail,
      // Structured kind: the orchestrator's fail-fast decision keys on this,
      // not on the message wording (CORE-7).
      errorKind: isTimeout ? "timeout" : undefined,
      execution_ms: Date.now() - start,
    };
  } finally {
    // 6. Cleanup — always remove container
    run("docker", ["rm", "-f", id]).catch(() => {});
  }
}

import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LOCAL_MOUNT_PATH } from "@/lib/constants";
import { run, parseExecutionOutput, codeDoesRemoteIo } from "./docker-utils";
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

  try {
    // 1. Create container (with optional bind-mount for browsed local files)
    const runArgs = ["run", "-d", "--name", id];
    if (localMountPath) {
      runArgs.push("-v", `${localMountPath}:${LOCAL_MOUNT_PATH}:ro`);
    }
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "300");
    logger.debug("Docker: creating container", {
      id,
      hasMount: !!localMountPath,
      hasParquet: !!inputParquetPath,
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

    // 4. Run script. Large local Parquet (mount / copied-in) and slow remote
    //    cloud reads (s3://, https:// via httpfs) both need the extended timeout.
    const isLargeData = !!localMountPath || !!inputParquetPath || codeDoesRemoteIo(code);
    const execTimeout = isLargeData ? SANDBOX_TIMEOUT_MS * 10 : SANDBOX_TIMEOUT_MS;
    logger.info("Docker: executing script", { execTimeout, largeData: isLargeData });
    const execResult = await run(
      "docker",
      [
        "exec",
        id,
        "sh",
        "-c",
        "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
      ],
      { timeoutMs: execTimeout }
    );

    // 5. Parse output
    return await parseExecutionOutput(id, start, execResult.stdout);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMsg.includes("timed out");

    // On timeout, try to grab stderr for context on what was running
    let detail = errorMsg;
    if (isTimeout) {
      try {
        const stderr = await run("docker", ["exec", id, "cat", "/data/stderr.txt"], {
          timeoutMs: 5_000,
        });
        if (stderr.stdout.trim()) {
          const lastLines = stderr.stdout.trim().split("\n").slice(-10).join("\n");
          detail = `Sandbox execution timed out. Last stderr:\n${lastLines}`;
        }
      } catch {
        // Container may already be gone
      }
    }

    return {
      success: false,
      error: detail,
      execution_ms: Date.now() - start,
    };
  } finally {
    // 6. Cleanup — always remove container
    run("docker", ["rm", "-f", id]).catch(() => {});
  }
}

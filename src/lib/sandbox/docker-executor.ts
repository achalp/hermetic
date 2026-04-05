import { randomUUID } from "node:crypto";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LOCAL_MOUNT_PATH } from "@/lib/constants";
import { run, parseExecutionOutput } from "./docker-utils";
import { logger } from "@/lib/logger";

export async function executeSandbox(
  csvContent: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  localMountPath?: string
): Promise<ExecutionResult> {
  const start = Date.now();
  const id = `hermetic-sandbox-${randomUUID()}`;

  try {
    // 1. Create container (with optional bind-mount for local files)
    const runArgs = ["run", "-d", "--name", id];
    if (localMountPath) {
      runArgs.push("-v", `${localMountPath}:${LOCAL_MOUNT_PATH}:ro`);
    }
    runArgs.push(DOCKER_SANDBOX_IMAGE, "sleep", "300");
    logger.debug("Docker: creating container", { id, hasMount: !!localMountPath });
    await run("docker", runArgs, { timeoutMs: 15_000 });
    logger.debug("Docker: container created");

    // 2. Write data files (skip for local files — data is bind-mounted)
    if (!localMountPath) {
      await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/input.csv"], {
        input: csvContent,
        timeoutMs: 15_000,
      });

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
    }

    // 3. Write script via stdin (with NaN-safety prelude)
    await run("docker", ["exec", "-i", id, "sh", "-c", "cat > /data/script.py"], {
      input: PYTHON_NAN_PRELUDE + code,
      timeoutMs: 15_000,
    });
    logger.debug("Docker: script written");

    // 4. Run script
    const execTimeout = localMountPath ? SANDBOX_TIMEOUT_MS * 4 : SANDBOX_TIMEOUT_MS;
    logger.info("Docker: executing script", { execTimeout, localMount: !!localMountPath });
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

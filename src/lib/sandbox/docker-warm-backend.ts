import type { WarmSandboxBackend } from "./warm-backend";
import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile } from "@/lib/contracts/execution";
import { pythonNanPrelude } from "./prelude";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LARGE_DATA_TIMEOUT_MS } from "@/lib/constants";
import { run, parseExecutionOutput, codeDoesRemoteIo } from "./docker-utils";
import { sandboxMemoryRunArgs } from "./memory-budget";
import { logger } from "@/lib/logger";

const CONTAINER_NAME = "hermetic-warm";
const CONTAINER_LIFETIME = 86400; // 24 hours

export class DockerWarmBackend implements WarmSandboxBackend {
  async warmup(): Promise<void> {
    // Remove stale container first (ignore errors if it doesn't exist)
    await run("docker", ["rm", "-f", CONTAINER_NAME], { timeoutMs: 10_000 }).catch(() => {});

    // Create persistent container. Always --network none: the warm container
    // is shared across queries and created before any code is known, so it
    // gets the hardened default; code that needs network is routed to a fresh
    // ephemeral container by the dispatch in sandbox/index.ts instead.
    await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "--network",
        "none",
        ...(await sandboxMemoryRunArgs()),
        DOCKER_SANDBOX_IMAGE,
        "sleep",
        String(CONTAINER_LIFETIME),
      ],
      { timeoutMs: 15_000 }
    );

    logger.info("Warm Docker container created", { name: CONTAINER_NAME });
  }

  async loadData(
    csvId: string,
    csvContent: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<void> {
    // Clean existing data files (but keep container alive)
    await run("docker", ["exec", CONTAINER_NAME, "sh", "-c", "rm -rf /data/*"], {
      timeoutMs: 5_000,
    });

    // Write CSV
    await run("docker", ["exec", "-i", CONTAINER_NAME, "sh", "-c", "cat > /data/input.csv"], {
      input: csvContent,
      timeoutMs: 15_000,
    });

    // Write GeoJSON (if provided)
    if (geojsonContent) {
      await run("docker", ["exec", "-i", CONTAINER_NAME, "sh", "-c", "cat > /data/input.geojson"], {
        input: geojsonContent,
        timeoutMs: 15_000,
      });
    }

    // Write additional files (workbook sheets, runtime package, skill/user libs)
    if (additionalFiles && additionalFiles.length > 0) {
      for (const file of additionalFiles) {
        const safePath = file.path.replace(/'/g, "'\\''");
        const safeDir = safePath.slice(0, safePath.lastIndexOf("/")) || "/data";
        await run(
          "docker",
          [
            "exec",
            "-i",
            CONTAINER_NAME,
            "sh",
            "-c",
            `mkdir -p '${safeDir}' && cat > '${safePath}'`,
          ],
          { input: file.content, timeoutMs: 15_000 }
        );
      }
    }

    logger.debug("Warm Docker data loaded", { csvId });
  }

  async executeScript(code: string): Promise<ExecutionResult> {
    const start = Date.now();

    try {
      // Clean output files only (data stays)
      await run(
        "docker",
        [
          "exec",
          CONTAINER_NAME,
          "sh",
          "-c",
          "rm -f /data/script.py /data/output.json /data/stdout.txt /data/stderr.txt",
        ],
        { timeoutMs: 5_000 }
      );

      // Write script (with NaN-safety prelude)
      await run("docker", ["exec", "-i", CONTAINER_NAME, "sh", "-c", "cat > /data/script.py"], {
        input: pythonNanPrelude() + code,
        timeoutMs: 15_000,
      });

      // Execute — slow remote cloud reads (httpfs s3://, https://) need the
      // extended timeout, same as large local Parquet.
      const execTimeout = codeDoesRemoteIo(code) ? LARGE_DATA_TIMEOUT_MS : SANDBOX_TIMEOUT_MS;
      const execResult = await run(
        "docker",
        [
          "exec",
          CONTAINER_NAME,
          "sh",
          "-c",
          "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
        ],
        { timeoutMs: execTimeout }
      );

      return await parseExecutionOutput(CONTAINER_NAME, start, execResult.stdout);
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        execution_ms: Date.now() - start,
      };
    }
  }

  async executeFull(
    csvContent: string,
    code: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<ExecutionResult> {
    await this.warmup();
    await this.loadData("full-exec", csvContent, geojsonContent, additionalFiles);
    return this.executeScript(code);
  }

  async isHealthy(): Promise<boolean> {
    try {
      const result = await run("docker", ["exec", CONTAINER_NAME, "echo", "ok"], {
        timeoutMs: 5_000,
      });
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }

  async destroy(): Promise<void> {
    await run("docker", ["rm", "-f", CONTAINER_NAME], { timeoutMs: 10_000 }).catch(() => {});
    logger.info("Warm Docker container destroyed");
  }
}

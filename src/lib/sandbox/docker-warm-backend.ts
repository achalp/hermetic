import type { WarmSandboxBackend } from "./warm-sandbox";
import type { ExecutionResult } from "@/lib/types";
import { type AdditionalFile, PYTHON_NAN_PRELUDE } from "./index";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS } from "@/lib/constants";
import { run, parseExecutionOutput } from "./docker-utils";
import { logger } from "@/lib/logger";

const CONTAINER_NAME = "hermetic-warm";
const CONTAINER_LIFETIME = 86400; // 24 hours

export class DockerWarmBackend implements WarmSandboxBackend {
  async warmup(): Promise<void> {
    // Remove stale container first (ignore errors if it doesn't exist)
    await run("docker", ["rm", "-f", CONTAINER_NAME], { timeoutMs: 10_000 }).catch(() => {});

    // Create persistent container
    await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
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

    // Write additional files (workbook sheets)
    if (additionalFiles && additionalFiles.length > 0) {
      await run("docker", ["exec", CONTAINER_NAME, "mkdir", "-p", "/data/sheets"], {
        timeoutMs: 5_000,
      });
      for (const file of additionalFiles) {
        const safePath = file.path.replace(/'/g, "'\\''");
        await run("docker", ["exec", "-i", CONTAINER_NAME, "sh", "-c", `cat > '${safePath}'`], {
          input: file.content,
          timeoutMs: 15_000,
        });
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
        input: PYTHON_NAN_PRELUDE + code,
        timeoutMs: 15_000,
      });

      // Execute
      const execResult = await run(
        "docker",
        [
          "exec",
          CONTAINER_NAME,
          "sh",
          "-c",
          "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
        ],
        { timeoutMs: SANDBOX_TIMEOUT_MS }
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

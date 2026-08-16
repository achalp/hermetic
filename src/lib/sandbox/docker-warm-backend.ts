import type { WarmSandboxBackend } from "./warm-backend";
import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile } from "@/lib/contracts/execution";
import { pythonNanPrelude } from "./prelude";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LARGE_DATA_TIMEOUT_MS } from "@/lib/constants";
import { run, parseExecutionOutput, codeDoesRemoteIo } from "./docker-utils";
import { sandboxMemoryRunArgs } from "./memory-budget";
import { sandboxHardeningRunArgs } from "./hardening";
import { logger, errMessage } from "@/lib/logger";
import type { SandboxRunHooks } from "@/lib/contracts/execution";

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
        ...sandboxHardeningRunArgs(),
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
    await this.writeFiles(additionalFiles ?? []);
    logger.debug("Warm Docker data loaded", { csvId });
  }

  /** Files-only writer — runs on EVERY execute (see WarmSandboxBackend). */
  async writeFiles(additionalFiles: AdditionalFile[]): Promise<void> {
    if (additionalFiles.length > 0) {
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
  }

  // The warm container is a docker label, exposed so callers/tests can reason
  // about which container a warm run touches.
  static readonly CONTAINER = CONTAINER_NAME;

  async executeScript(code: string, hooks?: SandboxRunHooks): Promise<ExecutionResult> {
    const start = Date.now();

    // Register the shared container so a user Stop can force-remove it and the
    // reaper knows it's a live run (finding M5). Deregistered in finally.
    hooks?.onContainerStart?.(CONTAINER_NAME);
    try {
      // Clean output AND per-run leftovers (data stays). A stale findings.jsonl
      // sidecar, DuckDB cfg dump, or step_* frame from a prior run in this
      // reused container would otherwise leak into this run (finding M5).
      // `find … -type f` deletes the hermetic_* files only — never the
      // hermetic_runtime PACKAGE directory writeFiles just installed.
      await run(
        "docker",
        [
          "exec",
          CONTAINER_NAME,
          "sh",
          "-c",
          "rm -f /data/script.py /data/output.json /data/stdout.txt /data/stderr.txt " +
            "/data/findings.jsonl /data/step_*; " +
            "find /data -maxdepth 1 -type f -name 'hermetic_*' -delete",
        ],
        { timeoutMs: 5_000 }
      );

      // Write script (with NaN-safety prelude)
      await run("docker", ["exec", "-i", CONTAINER_NAME, "sh", "-c", "cat > /data/script.py"], {
        input: pythonNanPrelude() + code,
        timeoutMs: 15_000,
      });

      // Execute — slow remote cloud reads (httpfs s3://, https://) need the
      // extended timeout, same as large local Parquet. Thread the run's abort
      // signal so a user Stop aborts the exec (not just the outer timeout).
      const execTimeout = codeDoesRemoteIo(code) ? LARGE_DATA_TIMEOUT_MS : SANDBOX_TIMEOUT_MS;
      try {
        const execResult = await run(
          "docker",
          [
            "exec",
            CONTAINER_NAME,
            "sh",
            "-c",
            "python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?",
          ],
          { timeoutMs: execTimeout, signal: hooks?.signal }
        );
        return await parseExecutionOutput(CONTAINER_NAME, start, execResult.stdout);
      } catch (execErr) {
        // Timeout/abort kills only the `docker exec` CLIENT — the python keeps
        // running in the SHARED container and can clobber the NEXT run's
        // /data/output.json (cross-run contamination). Reap it before returning.
        await run("docker", ["exec", CONTAINER_NAME, "pkill", "-f", "/data/script.py"], {
          timeoutMs: 5_000,
        }).catch(() => {});
        throw execErr;
      }
    } catch (err) {
      return {
        success: false,
        error: errMessage(err),
        execution_ms: Date.now() - start,
      };
    } finally {
      hooks?.onContainerEnd?.(CONTAINER_NAME);
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

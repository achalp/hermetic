import type { WarmSandboxBackend } from "./warm-backend";
import type { ExecutionResult } from "@/lib/contracts/execution";
import type { AdditionalFile } from "@/lib/contracts/execution";
import { pythonNanPrelude } from "./prelude";
import { DOCKER_SANDBOX_IMAGE, SANDBOX_TIMEOUT_MS, LARGE_DATA_TIMEOUT_MS } from "@/lib/constants";
import { run, parseExecutionOutput, codeDoesRemoteIo } from "./docker-utils";
import { buildTarArchive, type StageFile } from "./tar-stage";
import { createHash } from "node:crypto";
import { sandboxMemoryRunArgs } from "./memory-budget";
import { sandboxHardeningRunArgs } from "./hardening";
import { logger, errMessage } from "@/lib/logger";
import type { SandboxRunHooks } from "@/lib/contracts/execution";

// PER-PROCESS name (finding H4). The warm container is reused across a single
// process's runs, but web / MCP / CLI are SEPARATE processes against the same
// Docker daemon — a fixed name meant process B's `loadData` overwrote
// /data/input.csv while process A's script.py was mid-read (a confident WRONG
// answer), and B's warmup `docker rm -f` destroyed the container out from under
// A's exec. Encoding the pid gives each process its own container; the reaper
// below reclaims the ones left by crashed processes so per-process naming does
// not regress the old singleton's self-cleanup.
const WARM_PREFIX = "hermetic-warm-";
const CONTAINER_NAME = `${WARM_PREFIX}${process.pid}`;
const CONTAINER_LIFETIME = 86400; // 24 hours

/** True if `pid` is a live process on this host (EPERM = exists, not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Remove warm containers left behind by hermetic processes that have since
 * exited (crash, kill -9 — no chance to `destroy()`). Scoped to `hermetic-warm-
 * <pid>` whose pid is no longer alive; a live co-tenant process's container is
 * spared, and so is this process's own. Best-effort — a failure here must never
 * block warmup.
 */
async function reapDeadWarmContainers(): Promise<void> {
  try {
    const listed = await run(
      "docker",
      ["ps", "-a", "--filter", `name=${WARM_PREFIX}`, "--format", "{{.Names}}"],
      { timeoutMs: 10_000 }
    );
    const names = listed.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((n) => n.startsWith(WARM_PREFIX) && n !== CONTAINER_NAME);
    for (const name of names) {
      const pid = Number(name.slice(WARM_PREFIX.length));
      if (!Number.isInteger(pid) || pid <= 0 || isPidAlive(pid)) continue;
      await run("docker", ["rm", "-f", name], { timeoutMs: 10_000 }).catch(() => {});
    }
  } catch {
    // best-effort cleanup — never block warmup on it
  }
}

export class DockerWarmBackend implements WarmSandboxBackend {
  async warmup(): Promise<void> {
    // Reclaim warm containers orphaned by crashed hermetic processes, then
    // remove this process's own stale one (ignore errors if it doesn't exist).
    // Fresh container → nothing is staged: reset the P1 skip set.
    await reapDeadWarmContainers();
    await run("docker", ["rm", "-f", CONTAINER_NAME], { timeoutMs: 10_000 }).catch(() => {});
    this.stagedHashes.clear();

    // Create persistent container. Always --network none: the warm container
    // is shared across queries and created before any code is known, so it
    // gets the hardened default; code that needs network is routed to a fresh
    // ephemeral container by the dispatch in sandbox/index.ts instead.
    const created = await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER_NAME,
        "--network",
        "none",
        ...(await sandboxMemoryRunArgs()),
        ...(await sandboxHardeningRunArgs()),
        DOCKER_SANDBOX_IMAGE,
        "sleep",
        String(CONTAINER_LIFETIME),
      ],
      { timeoutMs: 15_000 }
    );
    // `run()` never throws — check the create explicitly, or every later exec
    // against the nonexistent container degrades to "Unknown execution error".
    // Throwing here is the warmup contract: the manager drops its warmupPromise
    // and the failure surfaces with the daemon's actual message.
    if (created.exitCode !== 0) {
      const detail =
        created.stderr.trim() || created.stdout.trim() || `exit code ${created.exitCode}`;
      throw new Error(`Failed to create the warm sandbox container: ${detail}`);
    }

    logger.info("Warm Docker container created", { name: CONTAINER_NAME });
  }

  /**
   * Per-container-lifetime record of NESTED staged files (path → content hash),
   * the perf-P1 skip set: the ~140KB hermetic_runtime package was re-written
   * (one `docker exec` per file) on EVERY warm run even though the bytes were
   * already present — the per-run cleanup only removes top-level /data files,
   * never nested package dirs. Only nested paths are recorded/skipped; TOP-LEVEL
   * files (step_*.csv, input.geojson) are always rewritten because the per-run
   * cleanup deletes them. Cleared whenever container contents are wiped
   * (warmup recreate, loadData's rm -rf, destroy) — a skip is only ever backed
   * by bytes this instance verifiably wrote to this container.
   */
  private stagedHashes = new Map<string, string>();

  private static isNested(path: string): boolean {
    return path.startsWith("/data/") && path.slice("/data/".length).includes("/");
  }

  /** Stage files in ONE `docker cp -` tar stream (perf P2), skipping nested
   *  files whose exact content is already in the container. Falls back to
   *  per-file writes when the tar builder rejects a path. */
  private async stage(files: StageFile[]): Promise<void> {
    const hash = (s: string) => createHash("sha1").update(s, "utf-8").digest("hex");
    const toWrite = files.filter(
      (f) =>
        !DockerWarmBackend.isNested(f.path) || this.stagedHashes.get(f.path) !== hash(f.content)
    );
    if (toWrite.length === 0) return;
    let ok = false;
    try {
      const archive = buildTarArchive(toWrite);
      const result = await run("docker", ["cp", "-", `${CONTAINER_NAME}:/data`], {
        input: archive,
        timeoutMs: 120_000,
      });
      ok = result.exitCode === 0;
    } catch (stageErr) {
      logger.warn("Warm Docker: tar staging fell back to per-file writes", {
        error: errMessage(stageErr),
      });
      ok = true;
      for (const file of toWrite) {
        const safePath = file.path.replace(/'/g, "'\\''");
        const safeDir = safePath.slice(0, safePath.lastIndexOf("/")) || "/data";
        const w = await run(
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
        // L3 sweep: a nonzero-exit fallback write must NOT teach the skip set —
        // recording an unwritten file's hash is an ABSORBING state (every later
        // warm run would skip staging a file that isn't there).
        if (w.exitCode !== 0) ok = false;
      }
    }
    // Record ONLY verified writes — a failed cp must not teach the skip set.
    if (ok) {
      for (const f of toWrite) {
        if (DockerWarmBackend.isNested(f.path)) this.stagedHashes.set(f.path, hash(f.content));
      }
    }
  }

  async loadData(
    csvId: string,
    csvContent: string,
    geojsonContent?: string | null,
    additionalFiles?: AdditionalFile[]
  ): Promise<void> {
    // Clean existing data files (but keep container alive). Full wipe →
    // everything previously staged is gone: reset the skip set.
    await run("docker", ["exec", CONTAINER_NAME, "sh", "-c", "rm -rf /data/*"], {
      timeoutMs: 5_000,
    });
    this.stagedHashes.clear();

    await this.stage([
      { path: "/data/input.csv", content: csvContent },
      ...(geojsonContent ? [{ path: "/data/input.geojson", content: geojsonContent }] : []),
      ...(additionalFiles ?? []).map((f) => ({ path: f.path, content: f.content })),
    ]);
    logger.debug("Warm Docker data loaded", { csvId });
  }

  /**
   * Files-only writer — runs on EVERY execute (see WarmSandboxBackend).
   *
   * ORDER MATTERS: the per-run cleanup runs HERE, BEFORE staging — it used to
   * live at the top of executeScript, i.e. AFTER this method had staged the
   * current run's files, so it deleted the step-dependency frames
   * (/data/step_N.csv) the run had just written and dependent warm steps read a
   * missing file (latent bug found during perf P1). Cleanup-then-stage removes
   * the PRIOR run's leftovers and stale frames, then writes the current run's.
   */
  async writeFiles(additionalFiles: AdditionalFile[]): Promise<void> {
    // A stale findings.jsonl sidecar, DuckDB cfg dump, or step_* frame from a
    // prior run in this reused container would otherwise leak into this run
    // (finding M5). `find … -type f` deletes the hermetic_* files only — never
    // the hermetic_runtime PACKAGE directory (whose staged contents the P1 skip
    // set relies on surviving between runs).
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
    await this.stage(additionalFiles.map((f) => ({ path: f.path, content: f.content })));
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
      // NOTE: the per-run cleanup now runs in writeFiles/loadData BEFORE staging
      // (see writeFiles) — running it here, AFTER staging, deleted the current
      // run's just-written step-dependency frames. executeScript's contract is
      // that the manager always calls loadData or writeFiles first.

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
    this.stagedHashes.clear();
    logger.info("Warm Docker container destroyed");
  }
}

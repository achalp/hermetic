import { mkdir, writeFile, appendFile, readdir, stat, rm } from "fs/promises";
import { join } from "path";
import { getRunId } from "@/lib/run-context";
import { logger } from "@/lib/logger";

/**
 * Incremental, best-effort forensic trail for a run.
 *
 * The user-facing history (data/history) is written ONCE, on completion, and a
 * FAILED run persists a near-empty stub — so when a run OOMs/crashes we lose the
 * exact generated code and per-attempt errors, i.e. we go blind on precisely the
 * runs we most need to debug. This recorder writes each artifact to
 * data/runs/<runId>/ the moment it's produced (code per attempt, each execution
 * outcome, the final code/output), so a crash or an exhausted-retry failure still
 * leaves a complete trail.
 *
 * Every call is fire-and-forget and swallows its own errors: recording must NEVER
 * slow down or break a run. Keyed by the AsyncLocalStorage runId, so callers don't
 * thread it; outside a run scope every function is a no-op.
 */

const RUNS_DIR = join(process.cwd(), "data", "runs");
const DEFAULT_MAX_RUNS = 200;
/** Cap a single recorded artifact so a huge output can't bloat disk. */
const MAX_ARTIFACT_BYTES = 512 * 1024;

function maxRuns(): number {
  const raw = Number(process.env.HERMETIC_MAX_RUN_RECORDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RUNS;
}

async function ensureRunDir(runId: string): Promise<string> {
  const dir = join(RUNS_DIR, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Write a named artifact (overwrites). Best-effort; never throws. */
export function recordRunArtifact(name: string, content: string): void {
  const runId = getRunId();
  if (!runId) return;
  void (async () => {
    try {
      const dir = await ensureRunDir(runId);
      const body =
        content.length > MAX_ARTIFACT_BYTES
          ? content.slice(0, MAX_ARTIFACT_BYTES) + "\n…[truncated by run-recorder]"
          : content;
      await writeFile(join(dir, name), body, "utf-8");
    } catch (err) {
      logger.debug("run-recorder: artifact write failed", { name, error: String(err) });
    }
  })();
}

/** Append one JSON event to the run's journal.jsonl (append-only → crash-safe ordering). */
export function recordRunEvent(event: Record<string, unknown>): void {
  const runId = getRunId();
  if (!runId) return;
  void (async () => {
    try {
      const dir = await ensureRunDir(runId);
      // Timestamp is stamped by the caller's clock; ISO for grep-ability.
      const line = JSON.stringify({ t: new Date().toISOString(), ...event });
      await appendFile(join(dir, "journal.jsonl"), line + "\n", "utf-8");
    } catch (err) {
      logger.debug("run-recorder: journal append failed", { error: String(err) });
    }
  })();
}

/**
 * Open the run's record: write meta.json and prune old run dirs. Call once at the
 * top of a run. Pruning here (not a background job) bounds data/runs the same way
 * history is bounded on save.
 */
export function recordRunStart(meta: Record<string, unknown>): void {
  const runId = getRunId();
  if (!runId) return;
  void (async () => {
    try {
      const dir = await ensureRunDir(runId);
      await writeFile(
        join(dir, "meta.json"),
        JSON.stringify({ runId, startedAt: new Date().toISOString(), ...meta }, null, 2),
        "utf-8"
      );
      await pruneOldRuns();
    } catch (err) {
      logger.debug("run-recorder: start failed", { error: String(err) });
    }
  })();
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Record one attempt's generated code — call BEFORE executing it, so a crash or
 * OOM mid-execution still leaves the exact code that ran.
 */
export function recordAttemptCode(attempt: number, code: string): void {
  recordRunArtifact(`attempt-${pad(attempt)}.py`, code);
  recordRunEvent({ type: "codegen", attempt, chars: code.length });
}

/** Record an attempt's execution outcome — call AFTER the sandbox returns. */
export function recordAttemptOutcome(
  attempt: number,
  outcome: {
    success: boolean;
    error?: string;
    errorKind?: string;
    executionMs?: number;
    hasResults?: boolean;
    /** Post-mortem diagnostics (config line, phase, stderr/stdout tails). */
    execDiag?: string;
  }
): void {
  recordRunEvent({
    type: "exec",
    attempt,
    success: outcome.success,
    errorKind: outcome.errorKind,
    executionMs: outcome.executionMs,
    hasResults: outcome.hasResults,
    errorHead: outcome.error?.slice(0, 500),
  });
  if (!outcome.success && outcome.error) {
    recordRunArtifact(`attempt-${pad(attempt)}.error.txt`, outcome.error);
  }
  // Always persist the exec diagnostics on failure — survives a hard-kill OOM
  // where the container is reaped before the console can surface the config line.
  if (!outcome.success && outcome.execDiag) {
    recordRunArtifact(`attempt-${pad(attempt)}.diag.txt`, outcome.execDiag);
  }
}

/** Keep only the newest `maxRuns` run directories; drop the rest. Best-effort. */
async function pruneOldRuns(): Promise<void> {
  try {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const cap = maxRuns();
    if (dirs.length <= cap) return;
    const withMtime = await Promise.all(
      dirs.map(async (name) => {
        try {
          const s = await stat(join(RUNS_DIR, name));
          return { name, mtime: s.mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
    );
    withMtime.sort((a, b) => b.mtime - a.mtime); // newest first
    for (const { name } of withMtime.slice(cap)) {
      await rm(join(RUNS_DIR, name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // RUNS_DIR may not exist yet, or a concurrent prune already ran — ignore.
  }
}

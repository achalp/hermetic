import { SANDBOX_CONTAINER_PREFIX } from "@/lib/constants";
import { execFile } from "node:child_process";
import { getRunId } from "@/lib/run-context";
import { logger } from "@/lib/logger";
import type { SkillFailureHint } from "@/lib/skills/types";
import { stateNamespace } from "@/lib/state-store";
import { registerRunLivenessProbe } from "@/lib/store-ttl";

/**
 * Per-run control registry — the single mechanism behind "stop on demand" and
 * "never kill a run ourselves", uniform across Ask and Investigate and every
 * source.
 *
 * Each streaming run registers ONE AbortController keyed by its runId. Every
 * long-running thing the run spawns subscribes to that signal: sandbox execs
 * (which also register their container id here so a stop can `docker rm -f`
 * them), LLM streams (via the AI SDK's abortSignal), warehouse polling. The
 * stop endpoint — a SEPARATE request, so it can't reach the run's
 * AsyncLocalStorage — looks the run up by id in this module-level map and
 * aborts it.
 *
 * There is deliberately NO timeout here. A connected, progressing analysis runs
 * until it finishes or the user stops it. Orphan cleanup (crash / restart) is
 * the store-sweeper's job: it reaps sandbox containers that are NOT registered
 * as active here (this map is the source of truth for "alive").
 *
 * Single-process model (one server = one map), same as the other globalThis
 * stores.
 */

/**
 * Source-agnostic progress event streamed to the client. Field names match the
 * on-the-wire shape the sandbox prelude's progress() emits (snake_case), so it
 * passes through untransformed.
 */
export interface SandboxProgress {
  /** Coarse phase: starting | scanning | analyzing | hydrating | composing | … */
  phase: string;
  /** Human-readable detail ("scanning California buildings"). */
  detail?: string;
  /** 0..1 completion when the phase can report it (e.g. a DuckDB scan). */
  fraction?: number;
  /** Rows processed so far / expected, when known. */
  rows?: number;
  total_rows?: number;
  /** Milliseconds since the run started. */
  elapsed_ms?: number;
  /** Extra fields the analysis code passes to progress(**fields). */
  [k: string]: unknown;
}

interface RunControl {
  controller: AbortController;
  /** Live sandbox container ids for this run (Investigate has several). */
  containers: Set<string>;
  /** Forwards sandbox progress to the run's patch stream. */
  onProgress?: (p: SandboxProgress) => void;
  /** Active skills' phase-keyed OOM remedies (see skills/types.ts). */
  failureHints?: SkillFailureHint[];
  startedAt: number;
  stopped: boolean;
}

const runs = stateNamespace<RunControl>("run-control");

// Provide the store-ttl active-run pin (M2-C4). The import points DOWNWARD
// (orchestration -> lib util) — the old coupling was store-ttl importing this
// registry, dragging it into every session store.
registerRunLivenessProbe(isRunActive);

/** Every sandbox container id ever registered → the runId that owns it. Lets the
 *  sweeper tell a live container from a crash orphan without scanning each run.
 *  MUST live on globalThis like `runs`: the sweeper is started from
 *  instrumentation.ts and API routes compile into separate dev module graphs, so
 *  a module-level Map here splits — the route registers containers in one
 *  instance while the sweeper reads another (empty) one and reaps every LIVE
 *  container on its tick as an "orphan" (observed: 11 mid-scan kills across
 *  three runs, all exactly on the 30-min sweep tick, misdiagnosed as OOM). */
const containerOwner = stateNamespace<string>("run-container-owner");

/**
 * Register the current run. Returns the AbortController whose signal all of the
 * run's long-running work should honor. Idempotent per runId.
 */
export function registerRun(
  runId: string,
  onProgress?: (p: SandboxProgress) => void
): AbortController {
  const existing = runs.get(runId);
  if (existing) {
    existing.onProgress = onProgress ?? existing.onProgress;
    return existing.controller;
  }
  const controller = new AbortController();
  runs.set(runId, {
    controller,
    containers: new Set(),
    onProgress,
    startedAt: Date.now(),
    stopped: false,
  });
  return controller;
}

/** The current run's abort signal (from AsyncLocalStorage), or undefined. */
export function getRunSignal(): AbortSignal | undefined {
  const runId = getRunId();
  return runId ? runs.get(runId)?.controller.signal : undefined;
}

/** True if the current run has been asked to stop. */
export function isRunStopped(): boolean {
  const runId = getRunId();
  return runId ? (runs.get(runId)?.stopped ?? false) : false;
}

/**
 * True while `runId` is still registered (between registerRun and endRun) — i.e.
 * an analysis is in-flight. Used to pin resources (e.g. a run's uploaded CSV) so
 * they are never swept out from under a legitimately long run.
 */
export function isRunActive(runId: string): boolean {
  return runs.has(runId);
}

/** Register a sandbox container against the CURRENT run (so a stop can kill it). */
export function registerContainer(containerId: string): void {
  const runId = getRunId();
  if (!runId) return;
  runs.get(runId)?.containers.add(containerId);
  containerOwner.set(containerId, runId);
}

export function unregisterContainer(containerId: string): void {
  const runId = getRunId();
  if (runId) runs.get(runId)?.containers.delete(containerId);
  containerOwner.delete(containerId);
}

/**
 * Attach the active skills' failure hints to the current run so the sandbox
 * output parser (which has no other channel to the skill activation) can match
 * them against the failing phase. Lives on RunControl — the globalThis-backed
 * registry — and is torn down with the run by endRun. No-op outside a run
 * context (tests, fingerprint containers).
 */
export function setRunFailureHints(hints: SkillFailureHint[]): void {
  const runId = getRunId();
  if (!runId) return;
  const rc = runs.get(runId);
  if (rc) rc.failureHints = hints;
}

/** The current run's skill failure hints ([] outside a run / none registered). */
export function getRunFailureHints(): SkillFailureHint[] {
  const runId = getRunId();
  return (runId && runs.get(runId)?.failureHints) || [];
}

/** Emit a progress event from the current run's sandbox into its patch stream. */
export function reportProgress(p: SandboxProgress): void {
  const runId = getRunId();
  if (!runId) return;
  try {
    runs.get(runId)?.onProgress?.(p);
  } catch {
    // Progress is best-effort — never let it break execution.
  }
}

/**
 * Stop a run by id (from the stop endpoint): flip its stopped flag, abort its
 * signal (so LLM streams / warehouse polling unwind), and force-remove every
 * container it registered (which kills the in-container process — killing the
 * `docker exec` client alone would not). Returns false if the run is unknown
 * (already finished).
 */
export async function stopRun(runId: string): Promise<boolean> {
  const rc = runs.get(runId);
  if (!rc) return false;
  rc.stopped = true;
  rc.controller.abort();
  const ids = [...rc.containers];
  logger.info("Run stop requested", { runId, containers: ids.length });
  await Promise.all(
    ids.map(
      (id) =>
        new Promise<void>((resolve) => {
          execFile("docker", ["rm", "-f", id], () => resolve());
        })
    )
  );
  return true;
}

/** Whether a sandbox container is registered to a live run (sweeper guard). */
export function isSandboxContainerActive(containerId: string): boolean {
  return containerOwner.has(containerId);
}

/** All sandbox container ids currently owned by a live run. */
export function activeSandboxContainerIds(): Set<string> {
  return new Set(containerOwner.keys());
}

/**
 * Reap orphaned analysis containers — the ONLY cleanup path for a
 * `sleep infinity` container whose run died without its finally (a crash, or a
 * server restart that emptied this registry). Removes any running
 * `hermetic-sandbox-*` container NOT registered to a live run. Scoped to that
 * prefix so the short-lived schema/fingerprint containers (which self-clean and
 * are never registered) are never touched. Safe against the create→register
 * window: registerContainer runs synchronously right after `docker run`
 * resolves, with no await between, so a container that exists is either
 * registered or a true orphan. Called by the store sweeper.
 *
 * Defense in depth: a container younger than ORPHAN_MIN_AGE_MS is SPARED even
 * when unregistered, and its name logged at warn — a true orphan (crash /
 * server restart) is by definition old news by the next tick, while an
 * unregistered-but-young container means the registration path is broken again
 * (the split-brain containerOwner bug killed live runs mid-scan for days
 * because the only trace was an anonymous count).
 */
const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;

export async function reapOrphanSandboxContainers(): Promise<number> {
  const names = await new Promise<string[]>((resolve) => {
    execFile(
      "docker",
      ["ps", "--filter", `name=${SANDBOX_CONTAINER_PREFIX}`, "--format", "{{.Names}}"],
      (err: unknown, stdout: string) => {
        resolve(err ? [] : String(stdout).trim().split("\n").filter(Boolean));
      }
    );
  });
  const active = activeSandboxContainerIds();
  const candidates = names.filter((n) => !active.has(n));
  const orphans: string[] = [];
  const spared: string[] = [];
  await Promise.all(
    candidates.map(async (n) => {
      const createdIso = await new Promise<string | null>((resolve) => {
        execFile("docker", ["inspect", "--format", "{{.Created}}", n], (err, stdout) =>
          resolve(err ? null : String(stdout).trim())
        );
      });
      // Unparseable/missing Created (container already gone, odd daemon) → treat
      // as reapable; `rm -f` on a vanished container is a harmless no-op.
      const createdMs = createdIso ? Date.parse(createdIso) : NaN;
      if (Number.isFinite(createdMs) && Date.now() - createdMs < ORPHAN_MIN_AGE_MS) {
        spared.push(n);
      } else {
        orphans.push(n);
      }
    })
  );
  await Promise.all(
    orphans.map((n) => new Promise<void>((res) => execFile("docker", ["rm", "-f", n], () => res())))
  );
  if (spared.length) {
    logger.warn("Sweeper spared unregistered-but-young sandbox containers — registration broken?", {
      names: spared,
    });
  }
  if (orphans.length) {
    logger.info("Reaped orphan sandbox containers", { count: orphans.length, names: orphans });
  }
  return orphans.length;
}

/** Tear down a run's registry entry once its stream concludes. */
export function endRun(runId: string): void {
  const rc = runs.get(runId);
  if (rc) for (const id of rc.containers) containerOwner.delete(id);
  runs.delete(runId);
}

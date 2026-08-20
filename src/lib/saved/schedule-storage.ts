/**
 * Persisted schedule definitions for saved visualizations.
 *
 * Schedules live in a single JSON file at `<cwd>/data/schedules.json`. Each
 * schedule binds to a vizId and describes when to re-execute it.
 *
 * v1 cadences (kept simple — no full cron expressions):
 *   - "hourly"          — every hour, on the hour
 *   - "daily-9am"       — every day at 09:00 local
 *   - "daily-eod"       — every day at 18:00 local
 *   - "weekly-monday"   — every Monday at 09:00 local
 *   - "on-file-change"  — re-run when the source file's mtime changes
 *
 * Status tracking: lastRunAt, lastStatus ("success" | "error"), lastError.
 */

import { mkdir, readFile, rename } from "fs/promises";
import { dirname } from "path";
import { writeJsonFileAtomic } from "@/lib/json-file";
import { hermeticPaths } from "@/lib/paths";
import { logger, errMessage } from "@/lib/logger";

export type ScheduleCadence =
  | "hourly"
  | "daily-9am"
  | "daily-eod"
  | "weekly-monday"
  | "on-file-change";

export interface ScheduleEntry {
  vizId: string;
  cadence: ScheduleCadence;
  /** Auto-export formats. Server-side only (XLSX) is supported in v1. */
  autoExport: ("xlsx" | "csv")[];
  /** Created timestamp (epoch ms). */
  createdAt: number;
  /** Most-recent run timestamp (epoch ms), or null if never run. */
  lastRunAt: number | null;
  /** Outcome of the most recent run. */
  lastStatus: "success" | "error" | null;
  /** Error message from the most recent run, if it failed. */
  lastError: string | null;
  /** Computed next-run target (epoch ms). For "on-file-change", this is null. */
  nextRunAt: number | null;
}

// Resolved per call, not at import — a module-level const froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const schedulesPath = () => hermeticPaths.schedulesFile();

let cache: Map<string, ScheduleEntry> | null = null;
// Serializes read-modify-write against schedules.json WITHIN this process, so
// two concurrent mutators can't interleave at their await points and lose one
// another's change (finding M8).
let writeChain: Promise<unknown> = Promise.resolve();

async function ensureDir() {
  await mkdir(dirname(schedulesPath()), { recursive: true });
}

/**
 * Read the CURRENT on-disk schedules, bypassing the in-memory cache. A corrupt
 * (non-ENOENT) file is backed up before returning empty so a later write can't
 * destroy the only copy. Every mutation reads through here so it merges with —
 * rather than clobbers — entries another PROCESS wrote since our cache was
 * filled (finding M8: the old code persisted `[...cache.values()]`, a whole-file
 * snapshot from one process's possibly-stale view).
 */
async function loadFromDisk(): Promise<Map<string, ScheduleEntry>> {
  const path = schedulesPath();
  let failure: unknown;
  try {
    const raw = await readFile(path, "utf-8");
    const arr = JSON.parse(raw) as ScheduleEntry[];
    return new Map(arr.map((s) => [s.vizId, s]));
  } catch (err) {
    // Missing ≠ corrupt: ENOENT is the normal empty state; a parse/read failure
    // falls through to the backup below so a write can't destroy the only copy.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    failure = err;
  }
  const backupPath = `${path}.corrupt-${Date.now()}`;
  const backedUp = await rename(path, backupPath).then(
    () => true,
    () => false
  );
  logger.warn("schedules.json unreadable — starting fresh", {
    path,
    backupPath: backedUp ? backupPath : undefined,
    error: errMessage(failure),
  });
  return new Map();
}

/** Load schedules; cached in memory after first read (reads tolerate a slightly
 *  stale cache — only WRITES must be disk-fresh, which `mutate` handles). */
export async function loadSchedules(): Promise<Map<string, ScheduleEntry>> {
  if (cache) return cache;
  cache = await loadFromDisk();
  return cache;
}

/**
 * The single write path: queued behind any in-flight mutation, re-reads the
 * live on-disk map, applies `fn`'s delta to THAT (not to a stale cache), writes
 * atomically, and refreshes the read cache. Merges cross-process concurrent
 * writes; serializes same-process ones (finding M8). A residual cross-process
 * TOCTOU window between read and write remains (true simultaneous multi-process
 * writes are rare in local-first) but the lost-update from a stale full-snapshot
 * overwrite is gone.
 */
async function mutate<T>(fn: (map: Map<string, ScheduleEntry>) => T): Promise<T> {
  const run = writeChain.then(async () => {
    const map = await loadFromDisk();
    const result = fn(map);
    await ensureDir();
    await writeJsonFileAtomic(schedulesPath(), [...map.values()]);
    cache = map;
    return result;
  });
  // Keep the chain alive regardless of this op's outcome.
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/**
 * Compute the next run time after `now` for the given cadence.
 * Returns null for "on-file-change" (event-driven, not time-driven).
 */
export function computeNextRunAt(cadence: ScheduleCadence, now: Date = new Date()): number | null {
  if (cadence === "on-file-change") return null;

  const next = new Date(now);
  switch (cadence) {
    case "hourly": {
      next.setMinutes(0, 0, 0);
      next.setHours(now.getHours() + 1);
      return next.getTime();
    }
    case "daily-9am": {
      next.setHours(9, 0, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }
    case "daily-eod": {
      next.setHours(18, 0, 0, 0);
      if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }
    case "weekly-monday": {
      next.setHours(9, 0, 0, 0);
      // Day index: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      const dow = next.getDay();
      const daysUntilMonday = (1 - dow + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntilMonday);
      // If today is Monday and time has passed, the +7 above already handled it
      if (dow === 1 && next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 7);
      }
      return next.getTime();
    }
  }
}

export interface SetScheduleInput {
  vizId: string;
  cadence: ScheduleCadence;
  autoExport: ("xlsx" | "csv")[];
}

export async function setSchedule(input: SetScheduleInput): Promise<ScheduleEntry> {
  return mutate((map) => {
    const existing = map.get(input.vizId);
    const now = Date.now();
    const entry: ScheduleEntry = {
      vizId: input.vizId,
      cadence: input.cadence,
      autoExport: input.autoExport,
      createdAt: existing?.createdAt ?? now,
      lastRunAt: existing?.lastRunAt ?? null,
      lastStatus: existing?.lastStatus ?? null,
      lastError: existing?.lastError ?? null,
      nextRunAt: computeNextRunAt(input.cadence),
    };
    map.set(input.vizId, entry);
    return entry;
  });
}

export async function deleteSchedule(vizId: string): Promise<boolean> {
  return mutate((map) => map.delete(vizId));
}

export async function listSchedules(): Promise<ScheduleEntry[]> {
  const map = await loadSchedules();
  return [...map.values()];
}

export async function getSchedule(vizId: string): Promise<ScheduleEntry | undefined> {
  const map = await loadSchedules();
  return map.get(vizId);
}

export async function recordRunOutcome(
  vizId: string,
  outcome: { status: "success" | "error"; error?: string }
): Promise<void> {
  await mutate((map) => {
    const entry = map.get(vizId);
    if (!entry) return;
    const now = Date.now();
    entry.lastRunAt = now;
    entry.lastStatus = outcome.status;
    entry.lastError = outcome.status === "error" ? (outcome.error ?? "Unknown error") : null;
    entry.nextRunAt = computeNextRunAt(entry.cadence, new Date(now));
  });
}

/**
 * Walk all schedules and return those whose nextRunAt is at or before `now`.
 * "on-file-change" schedules are excluded (they're triggered by the watcher).
 */
export async function findDueSchedules(now: number = Date.now()): Promise<ScheduleEntry[]> {
  const all = await listSchedules();
  return all.filter((s) => s.nextRunAt !== null && s.nextRunAt <= now);
}

/** Find all on-file-change schedules so the watcher can register paths. */
export async function findFileWatchSchedules(): Promise<ScheduleEntry[]> {
  const all = await listSchedules();
  return all.filter((s) => s.cadence === "on-file-change");
}

/** Test-only: clear in-memory cache so the next load reads from disk. */
export function __clearScheduleCache() {
  cache = null;
}

/** Test-only: stub the in-memory cache so tests don't hit disk. */
export function __setScheduleCacheForTesting(map: Map<string, ScheduleEntry>) {
  cache = map;
}

/** Resolve the schedules.json path for tests that want to inspect it. */
export function __getSchedulesPath() {
  return schedulesPath();
}

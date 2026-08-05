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

import { mkdir, readFile, writeFile, rename } from "fs/promises";
import { dirname } from "path";
import { hermeticPaths } from "@/lib/paths";
import { logger } from "@/lib/logger";

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

async function ensureDir() {
  await mkdir(dirname(schedulesPath()), { recursive: true });
}

/** Load schedules from disk; cached in memory after first read. */
export async function loadSchedules(): Promise<Map<string, ScheduleEntry>> {
  if (cache) return cache;
  const path = schedulesPath();
  let failure: unknown;
  try {
    const raw = await readFile(path, "utf-8");
    const arr = JSON.parse(raw) as ScheduleEntry[];
    cache = new Map(arr.map((s) => [s.vizId, s]));
    return cache;
  } catch (err) {
    // Missing ≠ corrupt (record-store's RecordCorruptError distinction):
    // ENOENT is the normal empty state; a parse/read failure falls through
    // to the backup below so persist() can't destroy the only copy.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = new Map();
      return cache;
    }
    failure = err;
  }
  // Corrupt (or unreadable) file: preserve it before the next persist()
  // overwrites it — losing every schedule the user ever configured.
  const backupPath = `${path}.corrupt-${Date.now()}`;
  const backedUp = await rename(path, backupPath).then(
    () => true,
    () => false
  );
  logger.warn("schedules.json unreadable — starting fresh", {
    path,
    backupPath: backedUp ? backupPath : undefined,
    error: failure instanceof Error ? failure.message : String(failure),
  });
  cache = new Map();
  return cache;
}

async function persist() {
  if (!cache) return;
  await ensureDir();
  await writeFile(schedulesPath(), JSON.stringify([...cache.values()], null, 2), "utf-8");
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
  const map = await loadSchedules();
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
  await persist();
  return entry;
}

export async function deleteSchedule(vizId: string): Promise<boolean> {
  const map = await loadSchedules();
  const had = map.delete(vizId);
  if (had) await persist();
  return had;
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
  const map = await loadSchedules();
  const entry = map.get(vizId);
  if (!entry) return;
  const now = Date.now();
  entry.lastRunAt = now;
  entry.lastStatus = outcome.status;
  entry.lastError = outcome.status === "error" ? (outcome.error ?? "Unknown error") : null;
  entry.nextRunAt = computeNextRunAt(entry.cadence, new Date(now));
  await persist();
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

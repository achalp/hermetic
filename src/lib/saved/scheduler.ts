/**
 * Background scheduler for saved-visualization re-runs.
 *
 * Lifecycle:
 *  - `ensureSchedulerStarted()` is called on first import of any schedule
 *    API endpoint. It is a no-op if already running.
 *  - The scheduler ticks every 60 seconds, finds due schedules, and runs
 *    them. Status is persisted via `recordRunOutcome`.
 *  - File-watch schedules use chokidar; one watcher per source.csv path.
 *
 * Single-process model: one Next.js server = one scheduler. HMR reloads
 * in dev re-init from the persisted JSON, but in-flight runs are lost.
 *
 * Auto-export (v1): the latest computed dataset is written as XLSX to
 * `~/.hermetic/scheduled-runs/<vizId>/<isoTimestamp>.xlsx`. PDF/DOCX/PPTX
 * exports are deferred to v2 (need headless browser).
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import {
  loadSchedules,
  recordRunOutcome,
  findDueSchedules,
  findFileWatchSchedules,
  type ScheduleEntry,
} from "./schedule-storage";
import { loadSavedVisualization } from "./storage";
import { runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { logger } from "@/lib/logger";

const TICK_MS = 60_000;
const EXPORT_ROOT = join(homedir(), ".hermetic", "scheduled-runs");

let started = false;
let tickHandle: NodeJS.Timeout | null = null;

// vizId → chokidar watcher (only for "on-file-change" schedules)
const watchers = new Map<string, { close: () => Promise<void> }>();

async function autoExportXlsx(vizId: string, datasets: Record<string, Record<string, unknown>[]>) {
  // Write the largest dataset (or main) as XLSX with one sheet.
  const main = datasets.main ?? Object.values(datasets)[0];
  if (!main || !Array.isArray(main) || main.length === 0) return;

  // Lazy-import exceljs — keeps it out of the cold start
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("data");
  const headers = Object.keys(main[0]);
  sheet.addRow(headers);
  for (const row of main) {
    sheet.addRow(headers.map((h) => row[h] ?? ""));
  }

  const dir = join(EXPORT_ROOT, vizId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.xlsx`);
  const buffer = await wb.xlsx.writeBuffer();
  await writeFile(path, Buffer.from(buffer));
  logger.info("Scheduled run wrote XLSX", { vizId, path, rows: main.length });
}

async function autoExportCsv(vizId: string, datasets: Record<string, Record<string, unknown>[]>) {
  const main = datasets.main ?? Object.values(datasets)[0];
  if (!main || !Array.isArray(main) || main.length === 0) return;
  const headers = Object.keys(main[0]);
  const lines = [headers.join(",")];
  for (const row of main) {
    lines.push(
      headers
        .map((h) => {
          const v = row[h];
          if (v === null || v === undefined) return "";
          const s = typeof v === "object" ? JSON.stringify(v) : String(v);
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(",")
    );
  }
  const dir = join(EXPORT_ROOT, vizId);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}.csv`);
  await writeFile(path, lines.join("\n"));
  logger.info("Scheduled run wrote CSV", { vizId, path, rows: main.length });
}

/**
 * Re-run a saved visualization headlessly via the schema-compat fast path
 * (no LLM call). Captures the new artifacts, writes auto-exports, and
 * records the outcome.
 */
export async function runScheduleNow(
  entry: ScheduleEntry
): Promise<{ ok: boolean; error?: string }> {
  const { vizId } = entry;
  try {
    const loaded = await loadSavedVisualization(vizId);
    const result = await runPipelineWithCode(
      loaded.generatedCode,
      loaded.csvContent,
      loaded.meta.question,
      {
        runtime: getActiveSandboxRuntime(),
        csvId: vizId,
      }
    );
    const datasets = (result.executionResult.datasets ?? {}) as Record<
      string,
      Record<string, unknown>[]
    >;

    // Run auto-exports in parallel; failures here log but don't fail the run
    const exportTasks: Promise<unknown>[] = [];
    if (entry.autoExport.includes("xlsx")) {
      exportTasks.push(
        autoExportXlsx(vizId, datasets).catch((err) =>
          logger.warn("XLSX auto-export failed", { vizId, error: String(err) })
        )
      );
    }
    if (entry.autoExport.includes("csv")) {
      exportTasks.push(
        autoExportCsv(vizId, datasets).catch((err) =>
          logger.warn("CSV auto-export failed", { vizId, error: String(err) })
        )
      );
    }
    await Promise.all(exportTasks);

    await recordRunOutcome(vizId, { status: "success" });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Scheduled run failed", { vizId, error: msg });
    await recordRunOutcome(vizId, { status: "error", error: msg });
    return { ok: false, error: msg };
  }
}

async function tick() {
  try {
    const due = await findDueSchedules();
    if (due.length === 0) return;
    logger.info("Scheduler tick — running due schedules", { count: due.length });
    // Run sequentially to avoid sandbox contention
    for (const entry of due) {
      await runScheduleNow(entry);
    }
  } catch (err) {
    logger.error("Scheduler tick failed", { error: String(err) });
  }
}

async function setupFileWatchers() {
  // Lazy-import chokidar on first use
  const chokidar = (await import("chokidar")).default;
  const fileSchedules = await findFileWatchSchedules();
  for (const entry of fileSchedules) {
    if (watchers.has(entry.vizId)) continue;
    try {
      const loaded = await loadSavedVisualization(entry.vizId);
      // Only watch if the saved viz has a localPath (skip warehouse / upload sources)
      const path = loaded.meta.localPath;
      if (!path) continue;
      const watcher = chokidar.watch(path, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      });
      watcher.on("change", async () => {
        logger.info("File-change schedule fired", { vizId: entry.vizId, path });
        await runScheduleNow(entry);
      });
      watchers.set(entry.vizId, watcher);
    } catch (err) {
      logger.warn("Could not register file watcher", {
        vizId: entry.vizId,
        error: String(err),
      });
    }
  }
}

/**
 * Idempotent. First call starts the tick loop and registers file watchers.
 * Subsequent calls are no-ops.
 */
export async function ensureSchedulerStarted(): Promise<void> {
  if (started) return;
  started = true;
  await loadSchedules();
  await setupFileWatchers();
  tickHandle = setInterval(() => {
    tick().catch(() => {});
  }, TICK_MS);
  // Don't keep the Node process alive on this timer
  if (tickHandle.unref) tickHandle.unref();
  logger.info("Scheduler started");
}

/**
 * Stop the scheduler and release all watchers. Used by tests; production
 * callers don't need this.
 */
export async function __stopSchedulerForTesting(): Promise<void> {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  for (const [, w] of watchers) {
    await w.close().catch(() => {});
  }
  watchers.clear();
  started = false;
}

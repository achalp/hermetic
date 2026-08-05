/**
 * Persistent per-analysis cost log. One CSV per day under data/cost/, appended
 * with a row per analysis. Mirrors the on-disk convention of
 * src/lib/history/storage.ts (cwd-relative data dir). Day files older than
 * COST_RETENTION_DAYS are pruned on write — one file per active day is
 * otherwise unbounded growth (the prune-on-write pattern of run-recorder.ts).
 *
 * Append is read-modify-write via the shared papaparse helpers so the free-text
 * question/dataset are quoted correctly. Single-user local tool, so the small
 * race on concurrent appends to the same day file is acceptable.
 */
import { mkdir, readFile, writeFile, readdir, appendFile, unlink } from "fs/promises";
import { join } from "path";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { hermeticPaths } from "@/lib/paths";

// Resolved per call, not at import — a module-level const froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const costDir = () => hermeticPaths.costDir();

export const COST_HEADERS = [
  "timestamp",
  "date",
  "run_id",
  "dataset",
  "question",
  "mode",
  "models",
  "llm_calls",
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "output_tokens",
  "cost_usd",
  "duration_ms",
  "phase_breakdown",
] as const;

export interface CostRow {
  timestamp: string;
  date: string; // YYYY-MM-DD
  /** Correlation id joining this row to log lines and the diagnostics record. */
  run_id?: string;
  dataset: string;
  question: string;
  mode: string;
  models: string;
  llm_calls: number;
  input_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Wall clock of the whole run, ms. */
  duration_ms?: number;
  /** Per-phase cost rollup, e.g. "compose=$0.18(out:9500,calls:1,ms:8200); …". */
  phase_breakdown?: string;
}

function toStringRow(row: CostRow): Record<string, string> {
  return {
    timestamp: row.timestamp,
    date: row.date,
    run_id: row.run_id ?? "",
    dataset: row.dataset,
    question: row.question,
    mode: row.mode,
    models: row.models,
    llm_calls: String(row.llm_calls),
    input_tokens: String(row.input_tokens),
    cache_read_tokens: String(row.cache_read_tokens),
    cache_write_tokens: String(row.cache_write_tokens),
    output_tokens: String(row.output_tokens),
    cost_usd: row.cost_usd.toFixed(6),
    duration_ms: row.duration_ms !== undefined ? String(row.duration_ms) : "",
    phase_breakdown: row.phase_breakdown ?? "",
  };
}

/**
 * In-process append serialization. The previous read-modify-rewrite raced on
 * concurrent finishes (Ask + Investigate + compose-cell landing together) and
 * silently dropped rows — the exact loss mode the diagnostics module's
 * predecessor had (see run-diagnostics.ts header). Appends now go through a
 * promise chain (single-process app, so an in-module mutex is sufficient) and
 * each row is one appendFile — no rewrite, no loss, no interleaving.
 */
let appendChain: Promise<void> = Promise.resolve();

/** Keep day files this long; older ones are dropped on write. */
const COST_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Append one analysis's cost to data/cost/<date>.csv (creates header if new). */
export function appendCostRow(row: CostRow): Promise<void> {
  const next = appendChain.then(() => appendCostRowUnlocked(row));
  // The chain must survive a failed append; the caller still sees the rejection.
  appendChain = next.catch(() => {});
  // Fire-and-forget, outside the append chain: retention must never delay or
  // fail the append that triggered it (run-recorder's prune-on-write policy).
  void next.then(pruneOldCostFiles, () => {});
  return next;
}

/**
 * Delete day files past the retention window. Age comes from the filename
 * (files are date-named), so the match is strict — anything else in the dir
 * is never touched. Best-effort; never throws.
 */
async function pruneOldCostFiles(): Promise<void> {
  try {
    const dir = costDir();
    const cutoff = Date.now() - COST_RETENTION_DAYS * DAY_MS;
    for (const f of await readdir(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.csv$/.exec(f);
      if (!m) continue;
      const dayMs = Date.parse(m[1]);
      if (Number.isFinite(dayMs) && dayMs < cutoff) {
        await unlink(join(dir, f)).catch(() => {});
      }
    }
  } catch {
    // dir may not exist yet
  }
}

async function appendCostRowUnlocked(row: CostRow): Promise<void> {
  await mkdir(costDir(), { recursive: true });
  const file = join(costDir(), `${row.date}.csv`);

  // Serialize exactly one data row (strip the header papaparse prepends) and
  // guarantee a trailing newline — toCSVText omits it, and two appended rows
  // without a separator would merge into one unparseable line.
  const single = toCSVText({ headers: [...COST_HEADERS], data: [toStringRow(row)], rowCount: 1 });
  const newline = single.includes("\r\n") ? "\r\n" : "\n";
  const rawLine = single.slice(single.indexOf("\n") + 1);
  const line = rawLine.endsWith("\n") ? rawLine : rawLine + newline;
  const headerLine = single.slice(0, single.indexOf("\n") + 1);

  const existingHeader = await readFile(file, "utf-8").then(
    (t) => t.slice(0, t.indexOf("\n") + 1),
    () => null // new day file
  );

  if (existingHeader !== null && existingHeader !== headerLine) {
    // One-time migration: the file predates a header change (e.g. the run_id
    // column). Re-serialize the old rows under the current headers once —
    // positional appends against a stale header would misalign every column.
    const existing = parseCSV(await readFile(file, "utf-8")).data.map((r) => ({
      ...Object.fromEntries(COST_HEADERS.map((h) => [h, r[h] ?? ""])),
    }));
    const migrated = toCSVText({
      headers: [...COST_HEADERS],
      data: existing,
      rowCount: existing.length,
    });
    await writeFile(file, migrated.endsWith("\n") ? migrated : migrated + newline, "utf-8");
  }

  await appendFile(file, existingHeader === null ? headerLine + line : line, "utf-8");
}

/** All cost rows across all day files, newest analysis first. */
export async function listCostRows(): Promise<Record<string, string>[]> {
  let files: string[];
  try {
    files = (await readdir(costDir())).filter((f) => f.endsWith(".csv"));
  } catch {
    return []; // dir doesn't exist yet
  }
  const rows: Record<string, string>[] = [];
  for (const f of files) {
    try {
      rows.push(...parseCSV(await readFile(join(costDir(), f), "utf-8")).data);
    } catch {
      // Skip a corrupt/locked file rather than failing the whole list.
    }
  }
  rows.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return rows;
}

/**
 * Persistent per-analysis cost log. One CSV per day under data/cost/, appended
 * with a row per analysis. Mirrors the on-disk convention of
 * src/lib/history/storage.ts (cwd-relative data dir, no TTL — rows persist).
 *
 * Append is read-modify-write via the shared papaparse helpers so the free-text
 * question/dataset are quoted correctly. Single-user local tool, so the small
 * race on concurrent appends to the same day file is acceptable.
 */
import { mkdir, readFile, writeFile, readdir, appendFile } from "fs/promises";
import { join } from "path";
import { parseCSV, toCSVText } from "@/lib/csv/parser";

const COST_DIR = join(process.cwd(), "data", "cost");

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
  /** Per-phase cost rollup, e.g. "compose=$0.18(out:9500,calls:1); …". */
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

/** Append one analysis's cost to data/cost/<date>.csv (creates header if new). */
export function appendCostRow(row: CostRow): Promise<void> {
  const next = appendChain.then(() => appendCostRowUnlocked(row));
  // The chain must survive a failed append; the caller still sees the rejection.
  appendChain = next.catch(() => {});
  return next;
}

async function appendCostRowUnlocked(row: CostRow): Promise<void> {
  await mkdir(COST_DIR, { recursive: true });
  const file = join(COST_DIR, `${row.date}.csv`);

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
    files = (await readdir(COST_DIR)).filter((f) => f.endsWith(".csv"));
  } catch {
    return []; // dir doesn't exist yet
  }
  const rows: Record<string, string>[] = [];
  for (const f of files) {
    try {
      rows.push(...parseCSV(await readFile(join(COST_DIR, f), "utf-8")).data);
    } catch {
      // Skip a corrupt/locked file rather than failing the whole list.
    }
  }
  rows.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
  return rows;
}

/**
 * Persistent per-analysis cost log. One CSV per day under data/cost/, appended
 * with a row per analysis. Mirrors the on-disk convention of
 * src/lib/history/storage.ts (cwd-relative data dir, no TTL — rows persist).
 *
 * Append is read-modify-write via the shared papaparse helpers so the free-text
 * question/dataset are quoted correctly. Single-user local tool, so the small
 * race on concurrent appends to the same day file is acceptable.
 */
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { parseCSV, toCSVText } from "@/lib/csv/parser";

const COST_DIR = join(process.cwd(), "data", "cost");

export const COST_HEADERS = [
  "timestamp",
  "date",
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

/** Append one analysis's cost to data/cost/<date>.csv (creates header if new). */
export async function appendCostRow(row: CostRow): Promise<void> {
  await mkdir(COST_DIR, { recursive: true });
  const file = join(COST_DIR, `${row.date}.csv`);

  let existing: Record<string, string>[] = [];
  try {
    existing = parseCSV(await readFile(file, "utf-8")).data;
  } catch {
    // New day file.
  }
  const data = [...existing, toStringRow(row)];
  const csv = toCSVText({ headers: [...COST_HEADERS], data, rowCount: data.length });
  await writeFile(file, csv, "utf-8");
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

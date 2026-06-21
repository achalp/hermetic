/**
 * Failure-class telemetry. One CSV per day under data/diagnostics/, appended
 * with a row per pipeline failure (code execution, degenerate result, or
 * composer key-mismatch). Mirrors the on-disk convention of src/lib/cost/storage.ts.
 *
 * Purpose: stop guessing why analyses fail. The retry loop already knows the
 * failure kind + error text; this normalizes each into a coarse `error_class`
 * (e.g. py_KeyError, semantic_no_output, compose_key_unresolved, infra_no_credits)
 * plus the failing operation, so we can rank the real failure modes by frequency
 * instead of by anecdote.
 *
 * Strictly best-effort — recording must never break an analysis.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { logger } from "@/lib/logger";

const DIAG_DIR = join(process.cwd(), "data", "diagnostics");

export const FAILURE_HEADERS = [
  "timestamp",
  "date",
  "mode", // "ask" | "investigate"
  "stage", // "code-exec" | "compose"
  "attempt", // retry index (0 = initial)
  "kind", // "execution" | "semantic" | "compose" | "infra"
  "error_class",
  "detail", // failing op / reason snippet
] as const;

export type FailureKind = "execution" | "semantic" | "compose" | "infra";

export interface FailureClass {
  errorClass: string;
  detail: string;
}

/**
 * Normalize a failure into a coarse class + a short detail. Pure + synchronous
 * so it's unit-testable without touching disk.
 */
export function classifyFailure(kind: FailureKind, errorText: string): FailureClass {
  const t = errorText ?? "";

  // Infra first — these aren't code-quality failures and shouldn't be conflated.
  if (/credit balance is too low/i.test(t)) return { errorClass: "infra_no_credits", detail: "" };
  if (/AI_APICallError|Headers Timeout|Local LLM request failed|fetch failed|ECONNREFUSED/i.test(t))
    return { errorClass: "infra_llm", detail: "" };
  if (/SQL execution failed|Timeout exceeded|socket hang up/i.test(t)) {
    const why = /Timeout exceeded/i.test(t)
      ? "timeout"
      : /socket hang up/i.test(t)
        ? "hangup"
        : "sql_error";
    return { errorClass: "sql_exec", detail: why };
  }

  if (kind === "compose") {
    return { errorClass: "compose_key_unresolved", detail: firstLine(t).slice(0, 80) };
  }

  if (kind === "semantic") {
    if (/no results or chart data/i.test(t))
      return { errorClass: "semantic_no_output", detail: "" };
    if (/has no rows/i.test(t)) return { errorClass: "semantic_empty_chart", detail: "" };
    if (/only zero values/i.test(t)) return { errorClass: "semantic_all_zeros", detail: "" };
    if (/null\/NaN|null or NaN/i.test(t)) return { errorClass: "semantic_null_result", detail: "" };
    return { errorClass: "semantic_other", detail: firstLine(t).slice(0, 80) };
  }

  // Execution: pull the Python exception type and the failing operation.
  const exc = t.match(/\b([A-Z][A-Za-z]*Error)\b/);
  const errorClass = exc ? `py_${exc[1]}` : "py_other";
  const opMatch = t.match(/in <module>\s*\n?\s*([^\n]+)/);
  const detail = opMatch
    ? opMatch[1]
        .replace(/\s*\^+\s*$/, "")
        .trim()
        .slice(0, 80)
    : "";
  return { errorClass, detail };
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i === -1 ? s : s.slice(0, i)).trim();
}

export interface FailureEvent {
  mode?: string;
  stage: "code-exec" | "compose";
  attempt?: number;
  kind: FailureKind;
  /** Raw error/traceback text, classified into error_class + detail. */
  errorText?: string;
  /** Override the classifier (used by the compose stage, which has no traceback). */
  errorClass?: string;
  detail?: string;
}

/** Append one failure to data/diagnostics/<date>.csv. Best-effort; never throws. */
export async function recordFailure(ev: FailureEvent): Promise<void> {
  // Don't litter the working tree with diagnostics CSVs during unit tests.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return;
  try {
    const now = new Date();
    const timestamp = now.toISOString();
    const date = timestamp.slice(0, 10);
    const classified =
      ev.errorClass != null
        ? { errorClass: ev.errorClass, detail: ev.detail ?? "" }
        : classifyFailure(ev.kind, ev.errorText ?? "");

    const row: Record<string, string> = {
      timestamp,
      date,
      mode: ev.mode ?? "",
      stage: ev.stage,
      attempt: String(ev.attempt ?? 0),
      kind: ev.kind,
      error_class: classified.errorClass,
      detail: ev.detail ?? classified.detail,
    };

    await mkdir(DIAG_DIR, { recursive: true });
    const file = join(DIAG_DIR, `${date}.csv`);
    let existing: Record<string, string>[] = [];
    try {
      existing = parseCSV(await readFile(file, "utf-8")).data;
    } catch {
      // New day file.
    }
    const data = [...existing, row];
    await writeFile(
      file,
      toCSVText({ headers: [...FAILURE_HEADERS], data, rowCount: data.length }),
      "utf-8"
    );
  } catch (err) {
    logger.debug("recordFailure failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Per-run diagnostics — the "why did this run cost/behave this way" record.
 *
 * The old per-failure CSV append (failure-log.ts) was LOSSY: parallel
 * sub-questions appending concurrently raced on read-modify-write, so most
 * events were dropped (a 12-call run logged 2). And it only captured failures —
 * not the things that actually drive Investigate cost and quality:
 *   - ESCALATION: a sub-question rejecting the materialized snapshot and running
 *     its own warehouse query (doubles its code-gen). This was the dominant,
 *     invisible cost driver.
 *   - RETRIES + their error classes (reliability).
 *   - MATERIALIZATION: rows, sampled?, parquet?, sql repairs, aborts.
 *   - per-step STATUS (ok / degraded / failed) and which path it took.
 *
 * This collects structured events in-memory (AsyncLocalStorage, like the cost
 * accumulator) during a run, then writes ONE JSON record at the end via atomic
 * appendFile — no read-modify-write, so no races, no loss. Output:
 * data/diagnostics/<date>.jsonl (one run per line). Strictly best-effort.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, appendFile } from "fs/promises";
import { join } from "path";
import { getRunId } from "@/lib/run-context";
import { logger } from "@/lib/logger";
import { envConfig } from "@/lib/harness-slot";
import { hermeticPaths } from "@/lib/paths";

const DIAG_DIR = hermeticPaths.diagnosticsDir();

export interface DiagEvent {
  type: string;
  [k: string]: unknown;
}

interface DiagStore {
  events: DiagEvent[];
}

const store = new AsyncLocalStorage<DiagStore>();

/** Enter a diagnostics scope; diagEvent() calls inside accumulate. */
export function runWithDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ events: [] }, fn);
}

/** Record a structured event. No-op outside a diagnostics scope. */
export function diagEvent(type: string, data: Record<string, unknown> = {}): void {
  store.getStore()?.events.push({ type, ...data });
}

export function getDiagEvents(): DiagEvent[] | undefined {
  return store.getStore()?.events;
}

// ── Event shapes (loose — events are tagged by `step` text so per-step records
//    can be assembled without nested ALS across parallel sub-questions) ──

export interface MaterializationDiag {
  table?: string;
  rows?: number;
  sampled?: boolean;
  parquet?: boolean;
  sqlRepairs?: number;
  aborted?: boolean;
}

export interface StepDiag {
  step: string;
  /** csv-first | escalated | per-step-sql | fallback-csv | file */
  path?: string;
  escalated: boolean;
  escalationReason?: string;
  retries: number;
  retryClasses: string[];
  status?: string; // ok | degraded | failed
  statusReason?: string;
  /** Wall time of the step in ms (start → finish, incl. retries). */
  wallMs?: number;
}

export interface RunDiagnostics {
  timestamp: string;
  date: string;
  /** Correlation id joining this record to log lines and the cost row. */
  runId?: string;
  mode?: string;
  purpose?: string;
  question?: string;
  costUsd?: number;
  llmCalls?: number;
  materialization?: MaterializationDiag;
  steps: StepDiag[];
  /**
   * Progress-stage transitions in order ("stage" events from emitProgress).
   * These carry a NUMERIC step counter, so the string-keyed step grouping
   * above silently dropped them — the OBS-9 events never reached disk.
   */
  stages?: { stage: string; step?: number; total?: number }[];
  /**
   * Run-scoped failure evidence, persisted verbatim: sandbox_failure
   * (stderr/stdout tails, exit code) and investigation_failed (the partial
   * per-step trail — question/status/error/code — of a run that died
   * mid-investigation). These have no step key, so they too were dropped.
   */
  failures?: DiagEvent[];
  summary: {
    subQuestions: number;
    escalated: number;
    degraded: number;
    failed: number;
    totalRetries: number;
    retryClassCounts: Record<string, number>;
  };
}

/**
 * Assemble the per-run record from the raw event stream. Pure + synchronous, so
 * it's unit-testable without touching disk. Events are grouped by their `step`
 * key (the sub-question text); run-level events (materialization) stand alone.
 */
export function buildRunDiagnostics(
  events: DiagEvent[],
  meta: {
    timestamp: string;
    runId?: string;
    mode?: string;
    purpose?: string;
    question?: string;
    costUsd?: number;
    llmCalls?: number;
  }
): RunDiagnostics {
  const materializationEv = events.find((e) => e.type === "materialization");
  const materialization = materializationEv
    ? {
        table: materializationEv.table as string | undefined,
        rows: materializationEv.rows as number | undefined,
        sampled: materializationEv.sampled as boolean | undefined,
        parquet: materializationEv.parquet as boolean | undefined,
        sqlRepairs: materializationEv.sqlRepairs as number | undefined,
        aborted: materializationEv.aborted as boolean | undefined,
      }
    : undefined;

  // Group step-tagged events by sub-question, preserving first-seen order.
  const stepMap = new Map<string, StepDiag>();
  const order: string[] = [];
  const ensure = (key: string): StepDiag => {
    let s = stepMap.get(key);
    if (!s) {
      s = { step: key, escalated: false, retries: 0, retryClasses: [] };
      stepMap.set(key, s);
      order.push(key);
    }
    return s;
  };

  for (const e of events) {
    const key = typeof e.step === "string" ? e.step : undefined;
    if (!key) continue;
    const s = ensure(key);
    if (e.type === "escalation") {
      s.escalated = true;
      s.path = "escalated";
      if (typeof e.reason === "string") s.escalationReason = e.reason;
    } else if (e.type === "retry") {
      s.retries += 1;
      if (typeof e.errorClass === "string") s.retryClasses.push(e.errorClass);
    } else if (e.type === "step_done") {
      if (typeof e.status === "string") s.status = e.status;
      if (typeof e.statusReason === "string") s.statusReason = e.statusReason;
      if (typeof e.path === "string" && !s.escalated) s.path = e.path;
      if (typeof e.wallMs === "number") s.wallMs = e.wallMs;
    }
  }

  // Run-scoped event families (no string `step` key — the grouping above
  // can't carry them, and dropping them loses the failure post-mortem trail).
  const stages = events
    .filter((e) => e.type === "stage")
    .map((e) => ({
      stage: String(e.stage ?? ""),
      step: typeof e.step === "number" ? e.step : undefined,
      total: typeof e.total === "number" ? e.total : undefined,
    }));
  const FAILURE_EVENT_TYPES = new Set(["sandbox_failure", "investigation_failed"]);
  const failures = events.filter((e) => FAILURE_EVENT_TYPES.has(e.type));

  const steps = order.map((k) => stepMap.get(k)!);
  const retryClassCounts: Record<string, number> = {};
  let totalRetries = 0;
  for (const s of steps)
    for (const c of s.retryClasses) {
      retryClassCounts[c] = (retryClassCounts[c] ?? 0) + 1;
      totalRetries++;
    }

  return {
    timestamp: meta.timestamp,
    date: meta.timestamp.slice(0, 10),
    runId: meta.runId,
    mode: meta.mode,
    purpose: meta.purpose,
    question: meta.question,
    costUsd: meta.costUsd,
    llmCalls: meta.llmCalls,
    materialization,
    steps,
    stages: stages.length ? stages : undefined,
    failures: failures.length ? failures : undefined,
    summary: {
      subQuestions: steps.length,
      escalated: steps.filter((s) => s.escalated).length,
      degraded: steps.filter((s) => s.status === "degraded").length,
      failed: steps.filter((s) => s.status === "failed").length,
      totalRetries,
      retryClassCounts,
    },
  };
}

/** Write the run's diagnostics record as one JSONL line (atomic append). */
export async function writeRunDiagnostics(meta: {
  timestamp: string;
  mode?: string;
  purpose?: string;
  question?: string;
  costUsd?: number;
  llmCalls?: number;
}): Promise<void> {
  if (envConfig().VITEST || envConfig().NODE_ENV === "test") return;
  const events = getDiagEvents();
  if (!events) return;
  try {
    const record = buildRunDiagnostics(events, { ...meta, runId: getRunId() });
    await mkdir(DIAG_DIR, { recursive: true });
    await appendFile(
      join(DIAG_DIR, `${record.date}.jsonl`),
      JSON.stringify(record) + "\n",
      "utf-8"
    );
  } catch (err) {
    // warn, not debug: if the diagnostics writes silently break, the record
    // that explains escalations/retries/degradations disappears and nobody
    // notices until the next post-mortem needs it.
    logger.warn("writeRunDiagnostics failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Read persisted run records, newest first — the in-app reader for the JSONL
 * this module writes. It previously had no consumer at all (cost has
 * /api/cost + listCostRows; diagnostics required shell jq archaeology).
 */
export async function listRunDiagnostics(limit = 100): Promise<RunDiagnostics[]> {
  const { readdir, readFile } = await import("fs/promises");
  let files: string[];
  try {
    files = (await readdir(DIAG_DIR)).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return []; // dir doesn't exist yet
  }
  const records: RunDiagnostics[] = [];
  // Newest day files first; within a file, later lines are later runs.
  for (const f of files.reverse()) {
    try {
      const lines = (await readFile(join(DIAG_DIR, f), "utf-8")).trim().split("\n").reverse();
      for (const line of lines) {
        try {
          records.push(JSON.parse(line) as RunDiagnostics);
        } catch {
          // skip a corrupt line rather than failing the whole list
        }
        if (records.length >= limit) return records;
      }
    } catch {
      // skip an unreadable file
    }
  }
  return records;
}

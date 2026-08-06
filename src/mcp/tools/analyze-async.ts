/**
 * Background analysis jobs: analyze as a start → poll → result trio (plus
 * cancel), for hosts that cap tool-call duration.
 *
 * Why this exists: Claude Desktop's chat host sends no progressToken and
 * cancels any tool call at a hard ~4 minutes — while a real hermetic
 * analysis routinely runs longer. No prompting fixes that (the HOST kills
 * the request, not the model). The protocol-level answer (SEP-1686 tasks)
 * isn't implemented by Anthropic hosts yet, so this is the same pattern one
 * layer up, as plain fast tools:
 *
 *   analyze_start  — kicks off the SAME serialized analyze pipeline
 *                    detached, returns {job_id} in milliseconds.
 *   analyze_status — LONG-POLLS: blocks until the stage changes, the job
 *                    settles, or wait_seconds elapses. The model cannot
 *                    sleep, so the waiting happens inside the tool call —
 *                    a 10-minute run becomes ~a dozen chained calls, each
 *                    safely under any host timeout.
 *   analyze_result — the stored analyze result, verbatim (including the
 *                    MCP-Apps UI payload, so the inline dashboard renders
 *                    off this call).
 *   analyze_cancel — stopRun on the live pipeline (the web app's stop
 *                    button, as a tool).
 *
 * The registry is process-lifetime and swept on access: settled jobs
 * expire after 30 min; a runaway running job is stopped at 60 min.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { analyze, analyzeInput, type AnalyzeDeps, type AnalyzeProgress } from "./analyze";
import { getSource } from "../sources";
import { McpToolError, errorCodeOf, unknownSource, type McpErrorCode } from "../errors";

export interface AnalysisJob {
  id: string;
  sourceId: string;
  question: string;
  status: "running" | "done" | "error" | "cancelled";
  stage: AnalyzeProgress | null;
  /** Bumps on every stage change — the long-poll wake key. */
  stageSeq: number;
  /** Pipeline correlation id, once the first stream patch reports it. */
  runId?: string;
  result?: Record<string, unknown>;
  error?: { message: string; code: McpErrorCode };
  startedAt: number;
  settledAt?: number;
  waiters: Array<() => void>;
}

const jobs = new Map<string, AnalysisJob>();

const SETTLED_TTL_MS = 30 * 60_000;
const RUNNING_MAX_MS = 60 * 60_000;
/** Long-poll bounds: default under the SDK's 60s client timeout; cap well
 *  under Claude Desktop chat's 4-minute kill. */
const DEFAULT_WAIT_S = 45;
const MAX_WAIT_S = 120;

/** Test hook: forget every job. */
export function _resetAnalysisJobs(): void {
  jobs.clear();
}

function notify(job: AnalysisJob): void {
  for (const wake of job.waiters.splice(0)) wake();
}

function settle(job: AnalysisJob, status: AnalysisJob["status"]): void {
  job.status = status;
  job.settledAt = Date.now();
  notify(job);
}

/** Swept on access, not on a timer — nothing to leak in tests or idle hosts. */
function sweep(deps: AnalyzeDeps, now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.settledAt && now - job.settledAt > SETTLED_TTL_MS) jobs.delete(id);
    else if (job.status === "running" && now - job.startedAt > RUNNING_MAX_MS) {
      if (job.runId) void deps.stopRun(job.runId).catch(() => {});
      job.error = { message: "Runaway guard: job exceeded 60 minutes.", code: "execution_failed" };
      settle(job, "error");
    }
  }
}

/** Resolves when the job's stage moves past sinceSeq, it settles, or ms pass. */
function waitForChange(job: AnalysisJob, sinceSeq: number, ms: number): Promise<void> {
  if (job.stageSeq !== sinceSeq || job.status !== "running" || ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(wake, ms);
    function wake() {
      clearTimeout(timer);
      resolve();
    }
    job.waiters.push(wake);
  });
}

function mustFind(jobId: string): AnalysisJob {
  const job = jobs.get(jobId);
  if (!job) {
    throw new McpToolError(
      "invalid_input",
      `Unknown job_id '${jobId}'. It may have expired (results are kept ~30 minutes) — ` +
        "start a new run with analyze_start."
    );
  }
  return job;
}

function snapshot(job: AnalysisJob): Record<string, unknown> {
  return {
    job_id: job.id,
    status: job.status,
    question: job.question,
    elapsed_seconds: Math.round(((job.settledAt ?? Date.now()) - job.startedAt) / 1000),
    ...(job.stage ? { stage: job.stage } : {}),
    ...(job.error ? { error: job.error.message } : {}),
    ...(job.status === "running"
      ? { next: "Call analyze_status again — the call blocks until there is progress." }
      : {}),
    ...(job.status === "done" ? { next: "Call analyze_result to get the full result." } : {}),
  };
}

// ── analyze_start ─────────────────────────────────────────

/** Identical to analyze — the job IS an analyze, just detached. */
export const analyzeStartInput = analyzeInput;

export function analyzeStart(
  deps: AnalyzeDeps,
  args: { source_id: string; question: string; purpose?: string }
): Record<string, unknown> {
  sweep(deps);
  // Fail fast on an unknown source — a background job must not swallow the
  // one error the caller could have fixed immediately.
  if (!getSource(args.source_id)) throw unknownSource(args.source_id);

  const job: AnalysisJob = {
    id: randomUUID(),
    sourceId: args.source_id,
    question: args.question,
    status: "running",
    stage: { stage: "starting" },
    stageSeq: 0,
    startedAt: Date.now(),
    waiters: [],
  };
  jobs.set(job.id, job);

  // The SAME pipeline as analyze — including the per-source serialization —
  // detached from any request lifetime. No host signal: only analyze_cancel
  // (or the runaway guard) stops it.
  void analyze(
    deps,
    args,
    (p) => {
      job.stage = p;
      job.stageSeq++;
      notify(job);
    },
    undefined,
    (runId) => {
      job.runId = runId;
    }
  ).then(
    (result) => {
      if (job.status !== "running") return; // cancelled while finishing
      job.result = result;
      settle(job, "done");
    },
    (err: unknown) => {
      if (job.status !== "running") return;
      job.error = {
        message: err instanceof Error ? err.message : String(err),
        code: errorCodeOf(err),
      };
      settle(job, "error");
    }
  );

  return {
    job_id: job.id,
    status: "running",
    question: args.question,
    next:
      "Call analyze_status with this job_id — it blocks until there is progress, so keep " +
      "calling it until status is 'done', then call analyze_result.",
  };
}

// ── analyze_status ────────────────────────────────────────

export const analyzeStatusInput = {
  job_id: z.string().describe("The job_id from analyze_start."),
  wait_seconds: z
    .number()
    .optional()
    .describe(
      `How long to block waiting for progress (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}). ` +
        "Pass 0 for an instant snapshot."
    ),
};

export async function analyzeStatus(
  deps: AnalyzeDeps,
  args: { job_id: string; wait_seconds?: number }
): Promise<Record<string, unknown>> {
  sweep(deps);
  const job = mustFind(args.job_id);
  const waitMs = Math.min(Math.max(args.wait_seconds ?? DEFAULT_WAIT_S, 0), MAX_WAIT_S) * 1000;
  await waitForChange(job, job.stageSeq, waitMs);
  return snapshot(job);
}

// ── analyze_result ────────────────────────────────────────

export const analyzeResultInput = {
  job_id: z.string().describe("The job_id from analyze_start."),
  wait_seconds: z
    .number()
    .optional()
    .describe(
      `If the job is still running, block up to this long for it to finish (default ` +
        `${DEFAULT_WAIT_S}, max ${MAX_WAIT_S}) before reporting status instead.`
    ),
};

export async function analyzeResult(
  deps: AnalyzeDeps,
  args: { job_id: string; wait_seconds?: number }
): Promise<Record<string, unknown>> {
  sweep(deps);
  const job = mustFind(args.job_id);
  const waitMs = Math.min(Math.max(args.wait_seconds ?? DEFAULT_WAIT_S, 0), MAX_WAIT_S) * 1000;
  // Wait for settlement, not just a stage change.
  const deadline = Date.now() + waitMs;
  while (job.status === "running" && Date.now() < deadline) {
    await waitForChange(job, job.stageSeq, deadline - Date.now());
  }
  if (job.status === "running") return snapshot(job);
  if (job.status === "cancelled") {
    throw new McpToolError("execution_failed", "This job was cancelled before it finished.");
  }
  if (job.status === "error") {
    // "internal" is the audit taxonomy's catch-all, not a throwable tool
    // code — surface it as an execution failure.
    const code = job.error?.code;
    throw new McpToolError(
      code && code !== "internal" ? code : "execution_failed",
      job.error?.message ?? "failed"
    );
  }
  // Done: the analyze result verbatim — withAudit lifts the UI payload into
  // structuredContent exactly as it does for the synchronous tool, so the
  // inline dashboard renders off THIS call.
  return { job_id: job.id, ...job.result };
}

// ── analyze_cancel ────────────────────────────────────────

export const analyzeCancelInput = {
  job_id: z.string().describe("The job_id from analyze_start."),
};

export async function analyzeCancel(
  deps: AnalyzeDeps,
  args: { job_id: string }
): Promise<Record<string, unknown>> {
  const job = mustFind(args.job_id);
  if (job.status !== "running") {
    return { job_id: job.id, status: job.status, note: "Job had already settled." };
  }
  if (job.runId) await deps.stopRun(job.runId).catch(() => {});
  // Settling first means the pipeline's eventual resolution is discarded —
  // the .then handlers only store into a still-running job.
  settle(job, "cancelled");
  return { job_id: job.id, status: "cancelled" };
}

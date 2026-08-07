/**
 * analyze — the flagship tool (mcp-server spec §3): run hermetic's full
 * tuned pipeline (code-gen → sandboxed execution → dashboard compose) and
 * return a summary, cost, and a link to the persisted interactive dashboard.
 *
 * Delegate-first by design (spec §1): the host model gets guaranteed
 * pipeline quality instead of hand-rolling analysis through primitives.
 * The response carries the narrative and aggregate artifacts only — the
 * computed dashboard lives in history; raw data stays home.
 */
import { z } from "zod";
// Pure leaf helpers (like the type-only contract imports other tools make) —
// the orchestration seams still come through McpDeps.
import { parsePatchLines, readRunError } from "@/lib/pipeline/patch-lines";
import type { PatchLine } from "@/lib/contracts/stream-state";
import type { AssembledSpec } from "@/lib/pipeline/assemble-spec";
import type { ResolvedAnalysisSource } from "@/lib/pipeline/validate-request";
import { PURPOSE_MODES } from "@/lib/purpose-prompts";
import { extractProse } from "@/lib/spec-summary";
import type { McpDeps } from "../deps";
import { getSource, reattachHint } from "../sources";
import { assertSourceLive } from "./liveness";
import { viewUrl, exportUrl } from "../view-url";
import { CHART_ROW_CAP } from "../caps";
import { McpToolError, unknownSource } from "../errors";
import { UI_PAYLOAD_KEY, dashboardUiPayload } from "../app-ui";
import { findingsMode } from "@/lib/findings";
import type { FindingsManifest } from "@/lib/contracts/findings";

/** The McpDeps slice analyze consumes (see LivenessDeps for the pattern). */
export type AnalyzeDeps = Pick<
  McpDeps,
  | "runPatchStream"
  | "stopRun"
  | "runAskQuery"
  | "getWarehouseState"
  | "getStoredCSV"
  | "getActiveSandboxRuntime"
  | "assembleSpecFromPatches"
  | "persistHistoryEntry"
  | "getCachedArtifacts"
  | "models"
>;

/**
 * One analyze at a time per source (review S8). The artifacts cache is keyed
 * by csvId and written mid-pipeline, so two concurrent runs on one source
 * would let the slower run read the faster run's numbers — returning run A's
 * narrative beside run B's figures, which then poisons verify_narrative.
 * Hosts dispatch tool calls concurrently, so this is reachable in normal use.
 */
const inFlight = new Map<string, Promise<unknown>>();

function serializedBySource<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
  const prior = inFlight.get(sourceId) ?? Promise.resolve();
  // Run whether or not the previous run succeeded.
  const next = prior.then(fn, fn);
  const tracked = next.catch(() => {});
  inFlight.set(sourceId, tracked);
  void tracked.then(() => {
    // Only the tail of the chain clears the entry.
    if (inFlight.get(sourceId) === tracked) inFlight.delete(sourceId);
  });
  return next;
}

/**
 * Purpose ids derived from the OWNING module (lib/purpose-prompts) so a new
 * output style reaches MCP without hand-sync — this enum was a hardcoded
 * copy. PURPOSE_MODES is a `Record<string, PurposeMode>` (its keys aren't
 * literal types), so the non-empty-tuple cast is what z.enum needs; it is
 * justified because the modes table is statically non-empty and legacy ids
 * are aliases resolved server-side (resolvePurpose), not canonical keys.
 */
const PURPOSE_IDS = Object.keys(PURPOSE_MODES) as [string, ...string[]];

export const analyzeInput = {
  source_id: z.string().describe("A source_id from connect_source (csv or warehouse)."),
  question: z.string().describe("The analysis question, in natural language."),
  purpose: z.enum(PURPOSE_IDS).optional().describe("Output style/breadth. Default: dashboard."),
};

// Chart rows come back capped (shared CHART_ROW_CAP, see ../caps) so the
// computed values are usable without flooding host context. Row-level
// `datasets` are never returned (boundary invariant) — these are the
// aggregates the dashboard itself charts.

/**
 * MCP response surface cap for the findings manifest (declared-findings
 * spec §4.3): tighter than the storage cap — host context is billed.
 * Truncates largest-first with an explicit flag, mirroring
 * chart_data_truncated_keys; NEVER silently.
 */
export const FINDINGS_RESPONSE_MAX_ENTRIES = 50;
export const FINDINGS_RESPONSE_MAX_BYTES = 8_000;

export function capFindingsForResponse(manifest: FindingsManifest): {
  findings: FindingsManifest;
  findings_truncated?: { dropped: number; total: number };
} {
  let entries = [...manifest.findings];
  const total = entries.length;
  const size = () => Buffer.byteLength(JSON.stringify(entries), "utf-8");
  if (entries.length > FINDINGS_RESPONSE_MAX_ENTRIES || size() > FINDINGS_RESPONSE_MAX_BYTES) {
    entries.sort((a, b) => JSON.stringify(a.value).length - JSON.stringify(b.value).length);
    entries = entries.slice(0, FINDINGS_RESPONSE_MAX_ENTRIES);
    while (entries.length > 0 && size() > FINDINGS_RESPONSE_MAX_BYTES) entries.pop();
  }
  const dropped = total - entries.length;
  return {
    findings: { manifest_version: manifest.manifest_version, findings: entries },
    ...(dropped > 0 ? { findings_truncated: { dropped, total } } : {}),
  };
}

export function capArtifacts(artifacts: {
  results?: Record<string, unknown>;
  chart_data?: Record<string, unknown>;
  sql?: string;
  findings?: FindingsManifest;
}): Record<string, unknown> {
  const chart: Record<string, unknown> = {};
  const truncated: string[] = [];
  for (const [k, v] of Object.entries(artifacts.chart_data ?? {})) {
    if (Array.isArray(v) && v.length > CHART_ROW_CAP) {
      // Downsample EVENLY, always keeping both endpoints — a head-slice
      // chopped a 142-year price series at 1974 and the reader's headline
      // chart lost the last forty years. For a time series, losing the
      // recent end is losing the answer.
      const step = (v.length - 1) / (CHART_ROW_CAP - 1);
      chart[k] = Array.from({ length: CHART_ROW_CAP }, (_, i) => v[Math.round(i * step)]);
      truncated.push(k);
    } else {
      chart[k] = v;
    }
  }
  return {
    results: artifacts.results ?? {},
    chart_data: chart,
    chart_data_truncated_keys: truncated,
    ...(artifacts.sql ? { sql: artifacts.sql } : {}),
    // Declared findings ship to hosts ONLY in mode "on" (spec §8); the
    // response cap keeps host context bounded with truncation flagged.
    ...(artifacts.findings && findingsMode() === "on"
      ? capFindingsForResponse(artifacts.findings)
      : {}),
  };
}

/**
 * Pipeline errors are phrased for the WEB app ("Please re-upload", "re-select
 * the file") — an MCP host has no upload button or file picker (review S14).
 * Rewrite the affordance, keep the cause. Patterns track the messages
 * run-ask-query actually throws ("Please re-upload." AND "Please re-upload
 * your data." — the earlier exact-suffix regex left the tail of the second
 * one dangling after the substitution).
 */
export function mcpifyError(message: string): string {
  return message
    .replace(
      /Please re-upload( your data)?\.?/gi,
      "Call connect_source again to re-attach the source."
    )
    .replace(
      /Please re-select the file\.?/gi,
      "Call connect_source again with the same path to re-attach it."
    )
    .replace(
      /Please connect to the warehouse first,? then ask your question\.?/gi,
      "Call connect_source with the warehouse connection_id first."
    );
}

/**
 * What the host should READ from a composed dashboard: the narrative prose
 * and the headline figures — not the chart labels.
 *
 * A naive "collect every string prop" summary is dominated by titles
 * ("MRR Trend Over Time", "Net MRR by Plan"), which tells the host nothing
 * and leaves verify_narrative with no numbers to check. So: prose comes from
 * the text-bearing components (TextBlock/Markdown/Annotation `content`), and
 * headline numbers come from StatCards as "label: value" — skipping values
 * that are state bindings rather than literals (those live in `results`).
 */
export function extractSummary(
  spec: Pick<AssembledSpec, "elements">,
  cap = 1500
): { summary: string; headline_stats: Array<{ label: string; value: number | string }> } {
  // Shared prose walker (lib/spec-summary) — same TextBlock/Annotation
  // defaults and literal-only StatCards this function used to hand-roll.
  // Title-only Annotations are dropped (empty content) to preserve this
  // response's established shape.
  const { prose, stats } = extractProse(spec, { statCards: true });
  const joined = prose
    .filter((p) => p.content !== "")
    .map((p) => p.text)
    .join("\n\n");
  return {
    summary: truncateAtBoundary(joined, cap),
    headline_stats: stats,
  };
}

/**
 * Cap the summary WITHOUT cutting mid-word (observed on every deep-dive run:
 * "marks the single largest…"). Prefer the last sentence end within the cap;
 * fall back to the last word boundary; hard-slice only for one giant token.
 */
export function truncateAtBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const window = text.slice(0, cap);
  const sentenceEnd = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf(".\n")
  );
  // A sentence boundary in the back half of the window reads best.
  if (sentenceEnd > cap / 2) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(" ");
  if (wordEnd > 0) return window.slice(0, wordEnd) + "…";
  return window + "…";
}

/** Coarse progress for the host: a stage name and, when known, step/total. */
export interface AnalyzeProgress {
  stage: string;
  detail?: string;
  step?: number;
  total?: number;
}

export type ProgressReporter = (p: AnalyzeProgress) => void;

/**
 * Turn a patch line into a progress update. The pipeline already publishes
 * `/state/__progress` (coarse phase) and `/state/__exec` (live sandbox phase
 * with an optional fraction) — this maps them, so the host is not blind for
 * the minutes a real analysis takes.
 */
export function progressFromPatch(patch: PatchLine): AnalyzeProgress | null {
  if (patch.path === "/state/__progress") {
    const v = patch.value as { stage?: string; step?: number; total?: number } | undefined;
    if (!v?.stage) return null;
    return { stage: v.stage, step: v.step, total: v.total };
  }
  if (patch.path === "/state/__exec") {
    const v = patch.value as { phase?: string; detail?: string; fraction?: number } | undefined;
    if (!v?.phase) return null;
    return {
      stage: `executing: ${v.phase}`,
      detail: v.detail,
      step: typeof v.fraction === "number" ? Math.round(v.fraction * 100) : undefined,
      total: typeof v.fraction === "number" ? 100 : undefined,
    };
  }
  if (patch.path === "/state/__estimate") {
    const v = patch.value as { detail?: string } | undefined;
    return v?.detail ? { stage: "estimating", detail: v.detail } : null;
  }
  return null;
}

export async function analyze(
  deps: AnalyzeDeps,
  args: { source_id: string; question: string; purpose?: string },
  onProgress?: ProgressReporter,
  signal?: AbortSignal,
  /** Fires when the pipeline's runId is known — the background-job tools
   *  (analyze-async.ts) need it to target stopRun before the run settles. */
  onRunId?: (runId: string) => void
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw unknownSource(args.source_id);
  return serializedBySource(source.id, () => runAnalyze(deps, args, onProgress, signal, onRunId));
}

async function runAnalyze(
  deps: AnalyzeDeps,
  args: { source_id: string; question: string; purpose?: string },
  onProgress?: ProgressReporter,
  signal?: AbortSignal,
  onRunId?: (runId: string) => void
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id)!;
  assertSourceLive(deps, source);

  // Build the discriminated source runAskQuery takes (validate-request's
  // union — the same narrowing the HTTP routes get from resolveQuerySources).
  let analysisSource: ResolvedAnalysisSource;
  if (source.kind === "warehouse") {
    const warehouseState = deps.getWarehouseState(source.id);
    if (!warehouseState) {
      // assertSourceLive just proved liveness; a vanish between the two
      // reads is the same expiry, reported the same actionable way.
      throw new McpToolError(
        "source_expired",
        `The warehouse connection "${source.label}" closed. ${reattachHint(source.origin)}`
      );
    }
    analysisSource = { kind: "warehouse", warehouseId: source.id, warehouseState };
  } else {
    analysisSource = { kind: "csv", csvId: source.csvId };
  }

  const lines: string[] = [];
  // Mutable by contract: warehouse runs materialize under a NEW csvId
  // reported mid-stream; history must persist under that id.
  const runState = {
    csvId: source.kind === "csv" ? source.csvId : undefined,
    question: args.question,
  };

  // Host cancellation (MCP notifications/cancelled → extra.signal): a run
  // the host gave up on must actually STOP — otherwise it burns LLM tokens
  // into the void and, worse, holds the per-source serialization lock so
  // every later analyze on this source queues behind a zombie. stopRun is
  // the same lever as the web app's stop button: aborts the run's signal
  // (LLM streams unwind) and force-removes its sandbox containers. The
  // in-flight runId arrives on the FIRST stream patch (`/state` add carries
  // __runId), so the sink below captures it before anything can abort.
  let liveRunId: string | undefined;
  let stopIssued = false;
  const stopIfAborted = () => {
    if (!signal?.aborted || stopIssued) return;
    stopIssued = true;
    if (liveRunId) void deps.stopRun(liveRunId).catch(() => {});
  };
  if (signal?.aborted) {
    throw new McpToolError("execution_failed", "The host cancelled the analysis.");
  }
  signal?.addEventListener("abort", stopIfAborted, { once: true });

  let runId: string | undefined;
  try {
    onProgress?.({ stage: "starting" });
    // runPatchStream returns the runId — the join key for this run's server
    // logs, diagnostics, and cost rows.
    runId = await deps.runPatchStream(
      "mcp:analyze",
      {
        write: (data: string) => {
          // Stream-side: capture the runId, then report progress per line.
          for (const patch of parsePatchLines([data])) {
            if (!liveRunId && patch.path === "/state") {
              const v = patch.value as { __runId?: string } | undefined;
              if (v?.__runId) {
                liveRunId = v.__runId;
                onRunId?.(liveRunId);
              }
            }
            const update = onProgress ? progressFromPatch(patch) : null;
            if (update) onProgress?.(update);
          }
          if (signal?.aborted) {
            stopIfAborted();
            // Throwing here flips the stream to closed — the pipeline's
            // isClosed checkpoints treat it like a disconnected client.
            throw new Error("host cancelled the analysis");
          }
          lines.push(data);
        },
      },
      async (stream) => {
        await deps.runAskQuery({
          context: { purpose: args.purpose ?? "dashboard" },
          question: args.question,
          source: analysisSource,
          codeGenModel: deps.models.codeGen,
          uiComposeModel: deps.models.uiCompose,
          sandboxRuntime: deps.getActiveSandboxRuntime(),
          runState,
          stream,
        });
      }
    );
  } finally {
    signal?.removeEventListener("abort", stopIfAborted);
  }

  if (signal?.aborted) {
    throw new McpToolError("execution_failed", "The host cancelled the analysis.");
  }

  const patches = parsePatchLines(lines);

  // Both pipelines emit the real message on `/state/__error` (typed channel,
  // contracts/stream-state); readRunError also covers a bare root="error".
  const runError = readRunError(patches);
  if (runError) {
    throw new McpToolError("execution_failed", `Analysis failed: ${mcpifyError(runError)}`);
  }

  const spec = deps.assembleSpecFromPatches(patches);
  if (!spec) throw new McpToolError("execution_failed", "Analysis produced no renderable result.");

  const cost = patches.find((p) => p.path === "/state/__cost")?.value ?? null;

  let dashboardUrl: string | null = null;
  let historyId: string | null = null;
  let persistError: string | null = null;
  if (runState.csvId) {
    const persisted = await deps.persistHistoryEntry(runState.csvId, spec, args.question);
    if (persisted.saved) {
      historyId = persisted.meta.id;
      dashboardUrl = viewUrl(historyId);
    } else {
      // Never a silent null: the host must be able to tell "no link" from
      // "analysis lost" (review S10).
      persistError = persisted.reason;
    }
  } else {
    persistError = "no csvId for this run — nothing to persist";
  }

  // The COMPUTED VALUES behind the dashboard — so a follow-up question about
  // a specific number needs no recomputation, and verify_narrative has
  // something to check prose against (they are the same values the dashboard
  // charts). Row-level datasets stay withheld.
  const cachedRaw = runState.csvId ? deps.getCachedArtifacts(runState.csvId) : undefined;
  // Belt and braces beside the per-source lock: the cache records the question
  // it was computed for, so a mismatch means these are someone else's numbers
  // and must NOT be returned as this run's (review S8).
  const cached =
    cachedRaw && cachedRaw.question && cachedRaw.question !== args.question ? undefined : cachedRaw;

  return {
    source_id: source.id,
    question: args.question,
    // The run's correlation id — joins this response to the server-side
    // logs/diagnostics/cost rows, and withAudit stamps it into the audit
    // line. Conditional: a test fake for runPatchStream may return nothing.
    ...(typeof runId === "string" ? { run_id: runId } : {}),
    ...extractSummary(spec),
    dashboard_url: dashboardUrl,
    // The single-file HTML download for the same entry — lets the host offer
    // "share this" without a second tool call (export_dashboard writes the
    // file server-side when a path is wanted instead).
    export_url: historyId ? exportUrl(historyId) : null,
    history_id: historyId,
    element_count: Object.keys(spec.elements).length,
    cost,
    ...(persistError ? { persist_error: persistError } : {}),
    ...(cached ? capArtifacts(cached) : {}),
    // The MCP-App iframe's data channel (app-ui.ts): the full renderable
    // spec. withAudit strips this key from the model-visible JSON and emits
    // it as structuredContent only for hosts that declared the ui extension.
    [UI_PAYLOAD_KEY]: dashboardUiPayload({
      spec,
      question: args.question,
      createdAt: new Date().toISOString(),
      dashboardUrl,
    }),
  };
}

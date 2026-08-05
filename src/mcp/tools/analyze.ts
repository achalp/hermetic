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
import { viewUrl } from "../view-url";
import { CHART_ROW_CAP } from "../caps";
import { McpToolError, unknownSource } from "../errors";

/** The McpDeps slice analyze consumes (see LivenessDeps for the pattern). */
export type AnalyzeDeps = Pick<
  McpDeps,
  | "runPatchStream"
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

export function capArtifacts(artifacts: {
  results?: Record<string, unknown>;
  chart_data?: Record<string, unknown>;
  sql?: string;
}): Record<string, unknown> {
  const chart: Record<string, unknown> = {};
  const truncated: string[] = [];
  for (const [k, v] of Object.entries(artifacts.chart_data ?? {})) {
    if (Array.isArray(v) && v.length > CHART_ROW_CAP) {
      chart[k] = v.slice(0, CHART_ROW_CAP);
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
    summary: joined.length > cap ? joined.slice(0, cap) + "…" : joined,
    headline_stats: stats,
  };
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
  onProgress?: ProgressReporter
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw unknownSource(args.source_id);
  return serializedBySource(source.id, () => runAnalyze(deps, args, onProgress));
}

async function runAnalyze(
  deps: AnalyzeDeps,
  args: { source_id: string; question: string; purpose?: string },
  onProgress?: ProgressReporter
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

  onProgress?.({ stage: "starting" });
  // runPatchStream returns the runId — the join key for this run's server
  // logs, diagnostics, and cost rows.
  const runId = await deps.runPatchStream(
    "mcp:analyze",
    {
      write: (data: string) => {
        lines.push(data);
        if (!onProgress) return;
        // Stream-side reporting: parse each line as it arrives, not at the end.
        for (const patch of parsePatchLines([data])) {
          const update = progressFromPatch(patch);
          if (update) onProgress(update);
        }
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
    history_id: historyId,
    element_count: Object.keys(spec.elements).length,
    cost,
    ...(persistError ? { persist_error: persistError } : {}),
    ...(cached ? capArtifacts(cached) : {}),
  };
}

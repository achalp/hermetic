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
import type { McpDeps } from "../deps";
import { getSource } from "../sources";
import { viewUrl } from "../view-url";

export const analyzeInput = {
  source_id: z.string().describe("A source_id from connect_source (csv or warehouse)."),
  question: z.string().describe("The analysis question, in natural language."),
  purpose: z
    .enum(["dashboard", "brief", "report", "deep-dive"])
    .optional()
    .describe("Output style/breadth. Default: dashboard."),
};

interface PatchLine {
  op?: string;
  path?: string;
  value?: unknown;
}

/** Pull the human-readable narrative out of a composed spec, capped. */
export function extractSummary(spec: { elements: Record<string, unknown> }, cap = 1500): string {
  const parts: string[] = [];
  for (const el of Object.values(spec.elements)) {
    const props = (el as { props?: Record<string, unknown> }).props;
    if (!props) continue;
    for (const key of ["content", "text", "title", "value"]) {
      const v = props[key];
      if (typeof v === "string" && v.trim().length > 0) parts.push(v.trim());
    }
  }
  const joined = parts.join("\n");
  return joined.length > cap ? joined.slice(0, cap) + "…" : joined;
}

export async function analyze(
  deps: McpDeps,
  args: { source_id: string; question: string; purpose?: string }
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw new Error(`Unknown source_id '${args.source_id}'. Call connect_source first.`);

  const lines: string[] = [];
  // Mutable by contract: warehouse runs materialize under a NEW csvId
  // reported mid-stream; history must persist under that id.
  const runState = {
    csvId: source.kind === "csv" ? source.csvId : undefined,
    question: args.question,
  };

  await deps.runPatchStream(
    "mcp:analyze",
    { write: (data: string) => void lines.push(data) },
    async (stream) => {
      await deps.runAskQuery({
        context: { purpose: args.purpose ?? "dashboard" },
        question: args.question,
        warehouseId: source.kind === "warehouse" ? source.id : undefined,
        warehouseState: source.kind === "warehouse" ? deps.getWarehouseState(source.id) : undefined,
        codeGenModel: deps.models.codeGen,
        uiComposeModel: deps.models.uiCompose,
        sandboxRuntime: deps.getActiveSandboxRuntime(),
        runState,
        stream,
      });
    }
  );

  const patches: PatchLine[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith(":")) continue;
    try {
      patches.push(JSON.parse(t));
    } catch {
      // progress noise
    }
  }

  const errorPatch = patches.find((p) => p.path === "/state/__error");
  const rootError = patches.some((p) => p.path === "/root" && p.value === "error");
  if (errorPatch || rootError) {
    throw new Error(
      `Analysis failed: ${typeof errorPatch?.value === "string" ? errorPatch.value : "pipeline error"}`
    );
  }

  const spec = deps.assembleSpecFromPatches(patches as never[]);
  if (!spec) throw new Error("Analysis produced no renderable result.");

  const cost = patches.find((p) => p.path === "/state/__cost")?.value ?? null;

  let dashboardUrl: string | null = null;
  let historyId: string | null = null;
  if (runState.csvId) {
    const persisted = await deps.persistHistoryEntry(
      runState.csvId,
      spec as unknown as Record<string, unknown>,
      args.question
    );
    if (persisted.saved) {
      historyId = persisted.meta.id;
      dashboardUrl = viewUrl(historyId);
    }
  }

  return {
    source_id: source.id,
    question: args.question,
    summary: extractSummary(spec as never),
    dashboard_url: dashboardUrl,
    history_id: historyId,
    element_count: Object.keys((spec as { elements: Record<string, unknown> }).elements).length,
    cost,
  };
}

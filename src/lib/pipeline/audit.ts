/**
 * On-demand non-blind audit (composer-sight spec §3).
 *
 * One high-effort adversarial review call over a completed analysis'
 * DERIVED bundle — question, results, findings+checks, chart series
 * samples, narrative texts, SQL. Raw datasets never enter the prompt.
 * User-triggered from the Verify tab; result persists on the history
 * entry. Pure prompt/parse functions here; the route owns I/O.
 */
import { generateText } from "ai";
import { z } from "zod";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { withPhase } from "@/lib/cost/accumulator";
import { getActiveModels } from "@/lib/runtime-config";
import { logger, errMessage } from "@/lib/logger";

export interface AuditBundle {
  question: string;
  results?: Record<string, unknown>;
  findings?: unknown;
  chartData?: Record<string, unknown>;
  narrativeTexts?: string[];
  sql?: string;
}

const AuditFinding = z.object({
  severity: z.enum(["high", "medium", "low"]),
  claim: z.string(),
  evidence: z.string(),
});
const AuditVerdict = z.object({
  verdict: z.enum(["clean", "issues"]),
  findings: z.array(AuditFinding).max(20).default([]),
});
export type AuditResult = z.infer<typeof AuditVerdict> & { at: number; model: string };

export const AUDIT_SYSTEM_PROMPT = `You are a distinguished data-science reviewer auditing a completed analysis. You see the DERIVED artifacts only (aggregates, findings, narrative) — never raw data. Hunt adversarially for what a careful reader would distrust:
- cross-channel disagreements (a finding vs a chart vs the narrative vs results);
- statistics misused (means over skewed data, insignificant results narrated as findings, invalid window comparisons, degenerate tests);
- silent conventions (zero/null policies applied inconsistently, endpoints that differ between elements);
- implausible magnitudes for the domain, framing not supported by the observed range;
- provenance gaps (headline values with nothing backing them).
Do the cheap arithmetic (recompute ratios, sum shares, compare maxima). Judge only what the bundle supports — flag what you cannot verify rather than assuming.
Respond with ONLY a JSON object, no fencing, no prose:
{"verdict":"clean|issues","findings":[{"severity":"high|medium|low","claim":"<one sentence: what is wrong>","evidence":"<the numbers/fields from the bundle that show it>"}]}
Empty findings with verdict "clean" means the bundle survived scrutiny.`;

/** Series arrays sampled head/tail so the bundle stays bounded. */
function sampleChartData(chartData: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(chartData)) {
    out[k] =
      Array.isArray(v) && v.length > 12
        ? { head: v.slice(0, 6), tail: v.slice(-6), rows: v.length }
        : v;
  }
  return out;
}

export const AUDIT_BUNDLE_MAX_BYTES = 60_000;

export function buildAuditPrompt(bundle: AuditBundle): string {
  const payload: Record<string, unknown> = {
    question: bundle.question,
    results: bundle.results ?? {},
    findings: bundle.findings ?? [],
    chart_data: sampleChartData(bundle.chartData ?? {}),
    narrative: (bundle.narrativeTexts ?? []).slice(0, 40),
    ...(bundle.sql ? { sql: bundle.sql } : {}),
  };
  let json = JSON.stringify(payload);
  if (Buffer.byteLength(json, "utf-8") > AUDIT_BUNDLE_MAX_BYTES) {
    delete payload.chart_data;
    json = JSON.stringify(payload);
  }
  return `Audit this analysis bundle:\n${json}`;
}

export function parseAuditResponse(text: string): z.infer<typeof AuditVerdict> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return AuditVerdict.parse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return null;
  }
}

/** Run the audit call. Never throws — a broken audit returns null. */
export async function runAudit(bundle: AuditBundle): Promise<AuditResult | null> {
  const model = getActiveModels().codeGen;
  try {
    const result = await withPhase("audit", () =>
      generateText({
        model: getModel(model),
        system: cachedSystem(AUDIT_SYSTEM_PROMPT),
        prompt: buildAuditPrompt(bundle),
        temperature: 0,
        maxOutputTokens: 4000,
      })
    );
    const parsed = parseAuditResponse(result.text);
    if (!parsed) return null;
    return { ...parsed, at: Date.now(), model };
  } catch (err) {
    logger.warn("audit run failed", {
      error: errMessage(err),
    });
    return null;
  }
}

/** Load a history entry, audit its derived bundle, persist the verdict as
 *  part of the entry's record (RECORD_FILES.audit — so it loads and exports
 *  along with the other artifacts). Shared by /api/audit and the MCP
 *  audit_analysis tool. */
export async function auditHistoryEntry(id: string): Promise<AuditResult | null> {
  const { loadHistoryEntry, saveHistoryAudit } = await import("@/lib/history/storage");
  const { collectNarrativeStrings } = await import("@/lib/pipeline/grounding");
  const entry = await loadHistoryEntry(id);
  const artifacts = (entry.artifacts ?? {}) as {
    results?: Record<string, unknown>;
    chart_data?: Record<string, unknown>;
    findings?: unknown;
    sql?: string;
  };
  const result = await runAudit({
    question: entry.meta.question,
    results: artifacts.results,
    chartData: artifacts.chart_data,
    findings: artifacts.findings,
    narrativeTexts: collectNarrativeStrings(entry.spec),
    sql: artifacts.sql,
  });
  if (result) {
    try {
      await saveHistoryAudit(id, result);
    } catch {
      // best-effort persistence
    }
  }
  return result;
}

/**
 * Per-analysis LLM cost tracking. An "analysis" (one Ask or Investigate request)
 * fans out into many LLM calls. To sum their token usage without threading an
 * accumulator through every pipeline function, the route enters an
 * AsyncLocalStorage scope (runWithCostTracking) and the getModel() middleware
 * (src/lib/llm/client.ts) reports each call's usage via recordCall(). At the end
 * the route reads the accumulator and computeCost() prices it.
 *
 * Token accounting (ai-SDK LanguageModelUsage): `inputTokens` is the TOTAL input
 * (uncached + cache-read + cache-write); the breakdown is in `inputTokenDetails`.
 * We price each bucket at its own Anthropic rate.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { MODEL_PRICING } from "@/lib/constants";

interface CallRecord {
  modelId: string;
  /** Which pipeline phase issued the call (planner / code_gen / compose / …). */
  phase: string;
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface CostAccumulator {
  calls: CallRecord[];
}

/** Per-phase token + cost rollup, so we can see WHERE a run spends. */
export interface PhaseBreakdown {
  phase: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface CostSummary {
  costUsd: number;
  /** total input tokens (uncached + cache read + cache write) */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  llmCalls: number;
  models: string[];
  /** Cost + tokens attributed by pipeline phase, descending by cost. */
  byPhase: PhaseBreakdown[];
}

/** Phase label for calls outside an explicit withPhase() scope. */
const DEFAULT_PHASE = "other";

/** One call's token buckets, already split by the caller (the getModel middleware). */
export interface CallUsage {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const costStore = new AsyncLocalStorage<CostAccumulator>();
const phaseStore = new AsyncLocalStorage<string>();

/** Run `fn` within a cost-tracking scope; LLM calls inside accumulate. */
export function runWithCostTracking<T>(fn: () => Promise<T>): Promise<T> {
  return costStore.run({ calls: [] }, fn);
}

/**
 * Tag every LLM call issued inside `fn` with a pipeline-phase label, so cost can
 * be attributed by phase (planner / sql_gen / code_gen / compose / …). Nestable;
 * the innermost scope wins. The cost middleware reads this when recording.
 */
export function withPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  return phaseStore.run(phase, fn);
}

/**
 * Synchronous variant for streamText(), which returns immediately and reports
 * usage later (during stream consumption, outside this scope). The cost
 * middleware captures the phase at request-initiation — which IS inside this
 * scope because streamText kicks off the request eagerly — so it sticks.
 */
export function withPhaseSync<T>(phase: string, fn: () => T): T {
  return phaseStore.run(phase, fn);
}

/** The phase active in the current async context (for the cost middleware). */
export function currentPhase(): string | undefined {
  return phaseStore.getStore();
}

/** The current scope's accumulator, or undefined outside a tracked analysis. */
export function getCostAccumulator(): CostAccumulator | undefined {
  return costStore.getStore();
}

/**
 * Record one LLM call's usage. No-op outside a tracked analysis scope. `phase`
 * is passed explicitly by the middleware (captured at request start so streamed
 * calls attribute correctly); it falls back to the ambient phase, then "other".
 */
export function recordCall(modelId: string, usage: CallUsage, phase?: string): void {
  const acc = costStore.getStore();
  if (!acc) return;
  acc.calls.push({
    modelId,
    phase: phase ?? phaseStore.getStore() ?? DEFAULT_PHASE,
    ...usage,
  });
}

/** Sum + price the accumulated calls. Models with no pricing entry cost $0. */
/** Compact one-line phase breakdown for logs and the cost CSV. */
export function formatPhaseBreakdown(byPhase: PhaseBreakdown[]): string {
  return byPhase
    .map((p) => `${p.phase}=$${p.costUsd.toFixed(4)}(out:${p.outputTokens},calls:${p.llmCalls})`)
    .join("; ");
}

/** Price one call's buckets; unknown models cost $0 (tokens still counted). */
function priceCall(c: CallRecord): number {
  const p = MODEL_PRICING[c.modelId];
  if (!p) return 0;
  return (
    (c.uncachedInputTokens * p.input +
      c.cacheReadTokens * p.cacheRead +
      c.cacheWriteTokens * p.cacheWrite +
      c.outputTokens * p.output) /
    1_000_000
  );
}

export function computeCost(acc: CostAccumulator): CostSummary {
  let costUsd = 0;
  let uncached = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  const models = new Set<string>();
  const phases = new Map<string, PhaseBreakdown>();
  for (const c of acc.calls) {
    models.add(c.modelId);
    uncached += c.uncachedInputTokens;
    cacheRead += c.cacheReadTokens;
    cacheWrite += c.cacheWriteTokens;
    output += c.outputTokens;
    const callCost = priceCall(c);
    costUsd += callCost;

    let ph = phases.get(c.phase);
    if (!ph) {
      ph = { phase: c.phase, llmCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      phases.set(c.phase, ph);
    }
    ph.llmCalls += 1;
    ph.inputTokens += c.uncachedInputTokens + c.cacheReadTokens + c.cacheWriteTokens;
    ph.outputTokens += c.outputTokens;
    ph.costUsd += callCost;
  }
  return {
    costUsd,
    inputTokens: uncached + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    llmCalls: acc.calls.length,
    models: [...models].sort(),
    byPhase: [...phases.values()].sort((a, b) => b.costUsd - a.costUsd),
  };
}

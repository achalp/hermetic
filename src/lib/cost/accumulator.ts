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
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface CostAccumulator {
  calls: CallRecord[];
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
}

/** One call's token buckets, already split by the caller (the getModel middleware). */
export interface CallUsage {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

const costStore = new AsyncLocalStorage<CostAccumulator>();

/** Run `fn` within a cost-tracking scope; LLM calls inside accumulate. */
export function runWithCostTracking<T>(fn: () => Promise<T>): Promise<T> {
  return costStore.run({ calls: [] }, fn);
}

/** The current scope's accumulator, or undefined outside a tracked analysis. */
export function getCostAccumulator(): CostAccumulator | undefined {
  return costStore.getStore();
}

/** Record one LLM call's usage. No-op outside a tracked analysis scope. */
export function recordCall(modelId: string, usage: CallUsage): void {
  const acc = costStore.getStore();
  if (!acc) return;
  acc.calls.push({ modelId, ...usage });
}

/** Sum + price the accumulated calls. Models with no pricing entry cost $0. */
export function computeCost(acc: CostAccumulator): CostSummary {
  let costUsd = 0;
  let uncached = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  const models = new Set<string>();
  for (const c of acc.calls) {
    models.add(c.modelId);
    uncached += c.uncachedInputTokens;
    cacheRead += c.cacheReadTokens;
    cacheWrite += c.cacheWriteTokens;
    output += c.outputTokens;
    const p = MODEL_PRICING[c.modelId];
    if (p) {
      costUsd +=
        (c.uncachedInputTokens * p.input +
          c.cacheReadTokens * p.cacheRead +
          c.cacheWriteTokens * p.cacheWrite +
          c.outputTokens * p.output) /
        1_000_000;
    }
  }
  return {
    costUsd,
    inputTokens: uncached + cacheRead + cacheWrite,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    llmCalls: acc.calls.length,
    models: [...models].sort(),
  };
}

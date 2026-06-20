import { describe, it, expect } from "vitest";
import {
  runWithCostTracking,
  getCostAccumulator,
  recordCall,
  computeCost,
} from "@/lib/cost/accumulator";
import { MODEL_PRICING, AVAILABLE_MODELS } from "@/lib/constants";

describe("computeCost / recordCall", () => {
  it("prices input and output tokens at the model's rate", async () => {
    const summary = await runWithCostTracking(async () => {
      recordCall("claude-sonnet-4-6", {
        uncachedInputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1_000_000,
      });
      return computeCost(getCostAccumulator()!);
    });
    // 1M input @ $3 + 1M output @ $15
    expect(summary.costUsd).toBeCloseTo(18, 6);
    expect(summary.inputTokens).toBe(1_000_000);
    expect(summary.outputTokens).toBe(1_000_000);
    expect(summary.llmCalls).toBe(1);
    expect(summary.models).toEqual(["claude-sonnet-4-6"]);
  });

  it("prices cache read and cache write at their own rates", async () => {
    const summary = await runWithCostTracking(async () => {
      recordCall("claude-sonnet-4-6", {
        uncachedInputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
        outputTokens: 0,
      });
      return computeCost(getCostAccumulator()!);
    });
    // 1M cache read @ $0.30 + 1M cache write @ $3.75
    expect(summary.costUsd).toBeCloseTo(4.05, 6);
    expect(summary.cacheReadTokens).toBe(1_000_000);
    expect(summary.cacheWriteTokens).toBe(1_000_000);
    expect(summary.inputTokens).toBe(2_000_000); // total includes cache buckets
  });

  it("sums across multiple calls and models", async () => {
    const summary = await runWithCostTracking(async () => {
      recordCall("claude-haiku-4-5-20251001", {
        uncachedInputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }); // $1
      recordCall("claude-sonnet-4-6", {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1_000_000,
      }); // $15
      return computeCost(getCostAccumulator()!);
    });
    expect(summary.costUsd).toBeCloseTo(16, 6);
    expect(summary.llmCalls).toBe(2);
    expect(summary.models.sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]);
  });

  it("treats an unknown/local model as $0 but still counts its tokens", async () => {
    const summary = await runWithCostTracking(async () => {
      recordCall("qwen2.5-coder:14b", {
        uncachedInputTokens: 5_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 2_000_000,
      });
      return computeCost(getCostAccumulator()!);
    });
    expect(summary.costUsd).toBe(0);
    expect(summary.inputTokens).toBe(5_000_000);
    expect(summary.outputTokens).toBe(2_000_000);
  });

  it("computeCost of an empty accumulator is all zeros", () => {
    const s = computeCost({ calls: [] });
    expect(s).toEqual({
      costUsd: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      llmCalls: 0,
      models: [],
    });
  });

  it("recordCall is a no-op outside a tracked scope", () => {
    expect(getCostAccumulator()).toBeUndefined();
    expect(() =>
      recordCall("claude-sonnet-4-6", {
        uncachedInputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
      })
    ).not.toThrow();
  });
});

describe("MODEL_PRICING", () => {
  it("covers every paid model in AVAILABLE_MODELS", () => {
    for (const m of AVAILABLE_MODELS) {
      expect(MODEL_PRICING[m.id], `missing pricing for ${m.id}`).toBeDefined();
    }
  });

  it("cache-write is 1.25x input and cache-read is 0.1x input", () => {
    for (const p of Object.values(MODEL_PRICING)) {
      expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 6);
      expect(p.cacheRead).toBeCloseTo(p.input * 0.1, 6);
    }
  });

  // Regression guard: Opus 4.x is $5/$25 per MTok — NOT the Claude 3 Opus
  // $15/$75 rate that was previously (wrongly) hard-coded.
  it("prices Opus at the 4.x rate ($5 in / $25 out)", () => {
    expect(MODEL_PRICING["claude-opus-4-8"]).toMatchObject({ input: 5, output: 25 });
  });
});

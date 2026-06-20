import { describe, it, expect } from "vitest";
import { isAdaptiveOnlyModel } from "@/lib/llm/client";

// Opus 4.7+ and the Fable/Mythos family reject temperature/top_p/top_k with a
// 400, so getModel strips those params only for these models. The 4.6-family
// (Sonnet 4.6, Haiku 4.5, Opus 4.6) still accept them.
describe("isAdaptiveOnlyModel", () => {
  it("flags Opus 4.7+ as adaptive-only", () => {
    expect(isAdaptiveOnlyModel("claude-opus-4-8")).toBe(true);
    expect(isAdaptiveOnlyModel("claude-opus-4-7")).toBe(true);
    expect(isAdaptiveOnlyModel("claude-opus-4-10")).toBe(true);
  });

  it("flags the Fable / Mythos family", () => {
    expect(isAdaptiveOnlyModel("claude-fable-5")).toBe(true);
    expect(isAdaptiveOnlyModel("claude-mythos-5")).toBe(true);
  });

  it("leaves the 4.6 family alone (they still accept sampling params)", () => {
    expect(isAdaptiveOnlyModel("claude-opus-4-6")).toBe(false);
    expect(isAdaptiveOnlyModel("claude-sonnet-4-6")).toBe(false);
    expect(isAdaptiveOnlyModel("claude-haiku-4-5-20251001")).toBe(false);
  });

  it("does not flag local / unknown model names", () => {
    expect(isAdaptiveOnlyModel("qwen2.5-coder:14b")).toBe(false);
    expect(isAdaptiveOnlyModel("gpt-4o")).toBe(false);
  });
});

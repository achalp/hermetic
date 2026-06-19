import { describe, it, expect } from "vitest";
import { parseDepthVerdict } from "@/lib/llm/followup-classifier";

describe("parseDepthVerdict — lookup-biased", () => {
  it("maps clear deep signals to deep", () => {
    expect(parseDepthVerdict("D")).toBe("deep");
    expect(parseDepthVerdict("d")).toBe("deep");
    expect(parseDepthVerdict("deep")).toBe("deep");
    expect(parseDepthVerdict("D — needs multi-step")).toBe("deep");
  });

  it("maps lookup signals to lookup", () => {
    expect(parseDepthVerdict("L")).toBe("lookup");
    expect(parseDepthVerdict("lookup")).toBe("lookup");
    expect(parseDepthVerdict("L.")).toBe("lookup");
  });

  it("defaults to lookup for empty/ambiguous/garbage output", () => {
    expect(parseDepthVerdict("")).toBe("lookup");
    expect(parseDepthVerdict("   ")).toBe("lookup");
    expect(parseDepthVerdict("maybe?")).toBe("lookup");
    expect(parseDepthVerdict("42")).toBe("lookup");
  });
});

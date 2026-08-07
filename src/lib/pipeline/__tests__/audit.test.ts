import { describe, it, expect } from "vitest";
import { buildAuditPrompt, parseAuditResponse, AUDIT_BUNDLE_MAX_BYTES } from "@/lib/pipeline/audit";

describe("audit prompt/parse (composer-sight spec §3)", () => {
  it("bundles derived artifacts, samples long series, and stays bounded", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ year: 1500 + i, v: i }));
    const prompt = buildAuditPrompt({
      question: "how have prices changed",
      results: { total: 1 },
      findings: [{ name: "t", value: { direction: "rising" } }],
      chartData: { series: rows },
      narrativeTexts: ["Median rose."],
      sql: "SELECT 1",
    });
    expect(prompt).toContain("how have prices changed");
    expect(prompt).toContain('"rows":500');
    expect(Buffer.byteLength(prompt, "utf-8")).toBeLessThan(AUDIT_BUNDLE_MAX_BYTES + 2000);
  });

  it("parses a verdict, tolerates prose around JSON, rejects garbage", () => {
    const ok = parseAuditResponse(
      'Here: {"verdict":"issues","findings":[{"severity":"high","claim":"c","evidence":"e"}]} done'
    );
    expect(ok?.verdict).toBe("issues");
    expect(ok?.findings[0].severity).toBe("high");
    expect(parseAuditResponse("no json at all")).toBeNull();
    expect(parseAuditResponse('{"verdict":"nope"}')).toBeNull();
  });
});

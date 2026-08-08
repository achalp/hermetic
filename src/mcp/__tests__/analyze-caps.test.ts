import { describe, it, expect } from "vitest";
import { capArtifacts } from "@/mcp/tools/analyze";

describe("capArtifacts — time series downsample, never head-slice", () => {
  it("keeps both endpoints when capping a long series", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ year: 1600 + i, v: i }));
    const out = capArtifacts({ results: {}, chart_data: { price_over_time: rows } });
    const capped = (out.chart_data as Record<string, { year: number }[]>).price_over_time;
    if (capped.length < rows.length) {
      expect(out.chart_data_truncated_keys as string[]).toContain("price_over_time");
      expect(capped[0].year).toBe(1600);
      expect(capped[capped.length - 1].year).toBe(2099);
    }
  });
});

describe("capFindingsForResponse — failed checks are undroppable (run-36)", () => {
  it("keeps the failed blocking check when the cap bites", async () => {
    const { capFindingsForResponse, FINDINGS_RESPONSE_MAX_ENTRIES } =
      await import("@/mcp/tools/analyze");
    const bulky = Array.from({ length: FINDINGS_RESPONSE_MAX_ENTRIES + 10 }, (_, i) => ({
      name: `finding_${i}`,
      definition: "a bulky finding with a large value payload attached to it",
      dtype: "trend",
      value: { data: "x".repeat(400), i },
    }));
    const indictment = {
      name: "scope_check",
      definition: "declared scope matches observed range",
      dtype: "check",
      tags: ["check", "blocking"],
      value: { passed: false, observed: [1970, 2012] },
    };
    const out = capFindingsForResponse({
      manifest_version: "1.0",
      findings: [...bulky, indictment],
    } as never);
    const names = out.findings.findings.map((f: { name: string }) => f.name);
    expect(names[0]).toBe("scope_check");
    expect(out.findings_truncated?.dropped).toBeGreaterThan(0);
  });
});

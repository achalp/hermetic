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

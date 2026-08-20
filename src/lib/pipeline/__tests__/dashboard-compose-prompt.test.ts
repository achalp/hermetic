/**
 * The generative-compose prompt builders (dashboard-compose-prompt.ts) — pure
 * assembly over an execution result: mirroredResultKeys, buildValuesSection,
 * and the full buildDashboardComposeRequest (which transitively runs
 * parseProduct / analyzeDatasets / headline plan / core prompt). No LLM/IO.
 */
import { describe, it, expect } from "vitest";
import {
  mirroredResultKeys,
  buildValuesSection,
  buildDashboardComposeRequest,
} from "@/lib/pipeline/dashboard-compose-prompt";
import type { SandboxExecutionResult } from "@/lib/contracts/execution";
import type { FindingsManifest } from "@/lib/contracts/findings";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const manifest = (): FindingsManifest => ({
  manifest_version: "1",
  findings: [
    {
      name: "churn_trend",
      dtype: "direction",
      definition: "trend of churn",
      value: { direction: "rising", slope_per_period: 0.5 },
    },
  ],
});

const execResult = (over: Partial<SandboxExecutionResult> = {}): SandboxExecutionResult => ({
  success: true,
  results: { churn_trend_direction: "rising", churn_trend_slope_per_period: 0.5, total: 1234 },
  chart_data: {
    monthly: [
      { m: "2024-01", v: 1 },
      { m: "2024-02", v: 2 },
    ],
  },
  images: {},
  datasets: {},
  execution_ms: 10,
  series: [],
  values: [],
  ...over,
});

const schema: CSVSchema = {
  csv_id: "c1",
  filename: "data.csv",
  row_count: 100,
  columns: [
    { name: "month", dtype: "string", null_count: 0, sample_values: ["2024-01"] } as never,
    { name: "churn", dtype: "float", null_count: 0, sample_values: ["0.1"] } as never,
  ],
  sample_rows: [],
};

describe("mirroredResultKeys", () => {
  it("finds result keys that mirror a finding's value fields", () => {
    const keys = mirroredResultKeys(
      { churn_trend_direction: "rising", churn_trend_slope_per_period: 0.5, unrelated: 1 },
      manifest()
    );
    expect(keys.has("churn_trend_direction")).toBe(true);
    expect(keys.has("churn_trend_slope_per_period")).toBe(true);
    expect(keys.has("unrelated")).toBe(false);
  });
  it("is empty with no manifest", () => {
    expect(mirroredResultKeys({ a: 1 }).size).toBe(0);
  });
});

describe("buildValuesSection", () => {
  it("emits finding_values, results, and series_samples", () => {
    const s = buildValuesSection(execResult(), manifest());
    expect(s).toContain("finding_values");
    expect(s).toContain("results");
    expect(s).toContain("series_samples");
    expect(s).toContain("churn_trend");
  });
  it("summarizes a long series into head/tail/rows", () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ i }));
    const s = buildValuesSection(execResult({ chart_data: { big: long } }), manifest());
    expect(s).toContain("rows");
  });
});

describe("buildDashboardComposeRequest", () => {
  it("assembles a system + user prompt grounded in the question and schema", () => {
    const req = buildDashboardComposeRequest(execResult(), {
      question: "how is churn trending?",
      schema,
      schemaMode: "metadata",
      purpose: "dashboard",
      priorTurns: [],
      findings: { manifest: manifest(), issues: [] },
    });
    expect(req.userPrompt).toContain("how is churn trending?");
    expect(Array.isArray(req.customRules)).toBe(true);
    expect(req.analysis).toBeDefined();
  });

  it("works without a findings manifest (findings off)", () => {
    const req = buildDashboardComposeRequest(execResult(), {
      question: "q2",
      schema,
      schemaMode: "metadata",
      purpose: "brief",
      priorTurns: [],
    });
    expect(req.userPrompt).toContain("q2");
  });
});

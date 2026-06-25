import { describe, it, expect } from "vitest";
import {
  collectGroundedValues,
  extractNumbers,
  extractCitedSteps,
  extractPlaceholderCitedSteps,
  verifyGrounding,
  __testing,
} from "@/lib/pipeline/grounding";

describe("collectGroundedValues", () => {
  it("pulls scalars from results and numeric cells from chart_data", () => {
    const grounded = collectGroundedValues(
      { total_revenue: 142300, margin: 0.342 },
      {
        bars: [
          { label: "West", profit: 890000 },
          { label: "East", profit: 720000 },
        ],
      }
    );
    expect(grounded).toContain(142300);
    expect(grounded).toContain(0.342);
    expect(grounded).toContain(890000);
    expect(grounded).toContain(720000);
  });

  it("accepts numeric strings emitted by python", () => {
    const grounded = collectGroundedValues({ count: "1,234" }, {});
    expect(grounded).toContain(1234);
  });
});

describe("extractNumbers", () => {
  it("parses currency, suffix, percent, and decimals", () => {
    const nums = extractNumbers("Revenue hit $4.7M, up 12.3%, from 1,234 orders.");
    const byRaw = Object.fromEntries(nums.map((n) => [n.raw.replace(/\s/g, ""), n]));
    expect(byRaw["$4.7M"].value).toBeCloseTo(4_700_000);
    expect(byRaw["$4.7M"].hadCurrency).toBe(true);
    expect(byRaw["12.3%"].hadPercent).toBe(true);
    expect(byRaw["12.3%"].value).toBeCloseTo(12.3);
    expect(byRaw["1,234"].value).toBe(1234);
  });

  it("does not consume the first letter of a following word as a suffix", () => {
    // "12 months" must parse as 12, not 12M; "5 buyers" as 5, not 5B.
    expect(extractNumbers("over 12 months")[0].value).toBe(12);
    expect(extractNumbers("5 buyers churned")[0].value).toBe(5);
    expect(extractNumbers("1,234 transactions")[0].value).toBe(1234);
  });

  it("still parses adjacent suffixes, including bn", () => {
    expect(extractNumbers("3bn users")[0].value).toBe(3e9);
    expect(extractNumbers("worth $1.2K.")[0].value).toBeCloseTo(1200);
  });
});

describe("isDataLike", () => {
  const { isDataLike, extractNumbers: ex } = __testing as unknown as {
    isDataLike: (n: ReturnType<typeof extractNumbers>[number]) => boolean;
    extractNumbers: typeof extractNumbers;
  };
  void ex;

  it("skips bare years and small counts", () => {
    expect(isDataLike(extractNumbers("in 2024")[0])).toBe(false);
    expect(isDataLike(extractNumbers("top 5 products")[0])).toBe(false);
  });

  it("flags dressed numbers even when small", () => {
    expect(isDataLike(extractNumbers("$4.50 per unit")[0])).toBe(true);
    expect(isDataLike(extractNumbers("2.3%")[0])).toBe(true);
  });

  it("flags large bare integers", () => {
    expect(isDataLike(extractNumbers("12,847 rows")[0])).toBe(true);
  });
});

describe("verifyGrounding", () => {
  const grounded = collectGroundedValues(
    { total_revenue: 4_683_120, growth: 0.123, orders: 1234 },
    { bars: [{ region: "West", profit: 890000 }] }
  );
  const successfulStepNos = [1, 2];

  it("passes when every figure traces to a computed value (with rounding + suffix)", () => {
    const report = verifyGrounding({
      narrativeTexts: [
        "Revenue reached $4.7M (Step 1), growing 12.3% (Step 2).",
        "West led with $890,000 in profit.",
      ],
      citedSteps: extractCitedSteps("Step 1 Step 2 $result:step_1_total_revenue"),
      grounded,
      successfulStepNos,
    });
    expect(report.ok).toBe(true);
    expect(report.ungrounded).toEqual([]);
    expect(report.citedSteps).toEqual([1, 2]);
  });

  it("flags a fabricated figure that matches nothing computed", () => {
    const report = verifyGrounding({
      narrativeTexts: ["Revenue reached $9.9M, far above target."],
      citedSteps: [1],
      grounded,
      successfulStepNos,
    });
    expect(report.ok).toBe(false);
    expect(report.ungrounded).toContain("$9.9M");
  });

  it("grounds a figure cited from a step DATASET table (not just results/chart_data)", () => {
    // The route walks per-step datasets into `grounded`; collectGroundedValues
    // picks numbers out of any nested structure, so a dataset row's value counts.
    const datasetNums = collectGroundedValues(
      {},
      { main: [{ industry: "X", median_revenue: 712_700_000 }] }
    );
    expect(datasetNums).toContain(712_700_000);
    const report = verifyGrounding({
      narrativeTexts: ["Least-variable industries have median revenue of $712.7M."],
      citedSteps: [2],
      grounded: [...grounded, ...datasetNums],
      successfulStepNos,
    });
    expect(report.ok).toBe(true);
  });

  it("does not flag the data-provenance row count when it's added to grounded", () => {
    // The route pushes the materialized row count / sample cap onto `grounded`
    // because "based on 1,000,000 rows" is a KNOWN value, not a hallucination.
    const report = verifyGrounding({
      narrativeTexts: ["Analysis based on a sample of 1,000,000 rows."],
      citedSteps: [1],
      grounded: [...grounded, 1_000_000],
      successfulStepNos,
    });
    expect(report.ok).toBe(true);
    expect(report.ungrounded).toEqual([]);
  });

  it("reports successful steps the narrative never cited", () => {
    const report = verifyGrounding({
      narrativeTexts: ["Revenue reached $4.7M."],
      citedSteps: [1],
      grounded,
      successfulStepNos,
    });
    expect(report.uncitedSuccessfulSteps).toEqual([2]);
  });

  it("does not double-report the same fabricated token", () => {
    const report = verifyGrounding({
      narrativeTexts: ["$9.9M here", "and $9.9M again"],
      citedSteps: [],
      grounded,
      successfulStepNos: [],
    });
    expect(report.ungrounded).toEqual(["$9.9M"]);
  });

  it("treats a ratio result shown as a percent as grounded", () => {
    const report = verifyGrounding({
      narrativeTexts: ["Margin was 12.3%."],
      citedSteps: [],
      grounded, // growth: 0.123
      successfulStepNos: [],
    });
    expect(report.ok).toBe(true);
  });

  it("accepts legitimately rounded suffixed figures at display precision", () => {
    // "1.2K" is orders=1234 rounded to one decimal at K scale — the author's
    // displayed precision is 100, not 0.1.
    const report = verifyGrounding({
      narrativeTexts: ["There were 1.2K orders."],
      citedSteps: [],
      grounded, // orders: 1234
      successfulStepNos: [],
    });
    expect(report.ok).toBe(true);
  });
});

describe("extractCitedSteps", () => {
  it("reads prose mentions and placeholder references", () => {
    expect(extractCitedSteps("See Step 2 and step_4")).toEqual([2, 4]);
    expect(extractCitedSteps('"$result:step_3_total"')).toEqual([3]);
  });

  it("reads plural citation lists — the form the composer prompt mandates", () => {
    expect(extractCitedSteps("Revenue roughly doubled (Steps 1, 4).")).toEqual([1, 4]);
    expect(extractCitedSteps("Both trends agree (Steps 2 and 5).")).toEqual([2, 5]);
    expect(extractCitedSteps("steps 1 and 4")).toEqual([1, 4]);
  });
});

describe("extractPlaceholderCitedSteps", () => {
  it("reads only placeholders — element IDs named after steps do not count", () => {
    const rawLine =
      '{"op":"add","path":"/elements/step_4_section","value":{"id":"step_4_chart","data":"$chartData:step_2_bars"}}';
    expect(extractPlaceholderCitedSteps(rawLine)).toEqual([2]);
  });
});

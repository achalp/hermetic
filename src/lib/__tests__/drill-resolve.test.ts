import { describe, it, expect } from "vitest";
import {
  resolveDrillValues,
  lineClickRecord,
  featureClickRecord,
  CLICK_PRIMARY,
  type ClickedRecord,
} from "@/lib/drill-resolve";
import type { DrillDownParams } from "@/lib/contracts/spec-types";

// The composer emits {"$item": col} bindings the type system can't express
// (filter_value is typed string | number). Build params loosely then cast.
function params(overrides: Record<string, unknown>): DrillDownParams {
  return {
    segment_label: "Region",
    segment_value: "",
    chart_title: null,
    x_key: null,
    y_key: null,
    filter_column: "region",
    filter_value: "",
    additional_filters: null,
    ...overrides,
  } as DrillDownParams;
}

const clicked = (r: Record<string, string | number>): ClickedRecord => r;

describe("resolveDrillValues — bar/pie $item bindings", () => {
  it("resolves an $item filter_value from the clicked real column", () => {
    const p = params({ filter_value: { $item: "region" }, filter_column: "region" });
    const r = resolveDrillValues(p, clicked({ region: "West", [CLICK_PRIMARY]: "West" }));
    expect(r).toEqual({ filterValue: "West", segmentLabel: "West", additionalFilters: [] });
  });

  it("falls back to the primary clicked value when the column name isn't captured (pie)", () => {
    // A pie slice knows its label but not the underlying column "region".
    const p = params({ filter_value: { $item: "region" }, filter_column: "region" });
    const r = resolveDrillValues(p, clicked({ [CLICK_PRIMARY]: "East" }));
    expect(r?.filterValue).toBe("East");
    expect(r?.segmentLabel).toBe("East");
  });

  it("overrides the composer's dimension-name label with the clicked value", () => {
    // Composer set segment_label to the dimension ("Region"); the drill should
    // be about the clicked value ("West"), not the dimension.
    const p = params({ filter_value: { $item: "region" }, segment_label: "Region" });
    const r = resolveDrillValues(p, clicked({ region: "West", [CLICK_PRIMARY]: "West" }));
    expect(r?.segmentLabel).toBe("West");
  });

  it("prefers the clicked value over a stale static filter_value", () => {
    const p = params({ filter_value: "West", filter_column: "region", segment_label: "Region" });
    const r = resolveDrillValues(p, clicked({ region: "East", [CLICK_PRIMARY]: "East" }));
    expect(r?.filterValue).toBe("East");
    expect(r?.segmentLabel).toBe("East");
  });

  it("preserves numeric clicked values", () => {
    const p = params({ filter_value: { $item: "year" }, filter_column: "year" });
    const r = resolveDrillValues(p, clicked({ year: 2025, [CLICK_PRIMARY]: 2025 }));
    expect(r?.filterValue).toBe(2025);
    expect(r?.segmentLabel).toBe("2025");
  });
});

describe("resolveDrillValues — multi-select (array) values", () => {
  it("passes a non-empty array filter_value through", () => {
    const p = params({
      filter_value: ["North", "East"] as unknown as string,
      filter_column: "region",
      segment_label: "Region",
    });
    const r = resolveDrillValues(p, null);
    expect(r?.filterValue).toEqual(["North", "East"]);
    // A static, non-empty segment_label is preserved as-is.
    expect(r?.segmentLabel).toBe("Region");
  });

  it("labels an array readably when no static label is given", () => {
    const p = params({
      filter_value: ["North", "East"] as unknown as string,
      filter_column: "region",
      segment_label: "",
    });
    expect(resolveDrillValues(p, null)?.segmentLabel).toBe("North, East");
  });

  it("treats an empty array as no selection (bails)", () => {
    const p = params({ filter_value: [] as unknown as string });
    expect(resolveDrillValues(p, null)).toBeNull();
  });

  it("carries an array in additional_filters", () => {
    const p = params({
      filter_value: "West",
      filter_column: "region",
      segment_label: "West",
      additional_filters: [{ column: "channel", value: ["Online", "Retail"] as unknown as string }],
    });
    const r = resolveDrillValues(p, null);
    expect(r?.additionalFilters).toEqual([{ column: "channel", value: ["Online", "Retail"] }]);
  });
});

describe("resolveDrillValues — value-less / unresolved clicks bail", () => {
  it("returns null for an $item binding with no captured click", () => {
    const p = params({ filter_value: { $item: "region" } });
    expect(resolveDrillValues(p, null)).toBeNull();
  });

  it("returns null when the binding field and primary are both absent", () => {
    const p = params({ filter_value: { $item: "region" } });
    expect(resolveDrillValues(p, clicked({ unrelated: "x" }))).toBeNull();
  });
});

describe("resolveDrillValues — static drills (PivotTable / legacy Ask)", () => {
  it("passes a static filter_value through unchanged when there is no click", () => {
    const p = params({ filter_value: "North", filter_column: "region", segment_label: "North" });
    const r = resolveDrillValues(p, null);
    expect(r).toEqual({ filterValue: "North", segmentLabel: "North", additionalFilters: [] });
  });

  it("keeps a static, non-binding segment_label when the value is static", () => {
    const p = params({
      filter_value: "West",
      segment_label: "West × Online",
      additional_filters: [{ column: "channel", value: "Online" }],
    });
    const r = resolveDrillValues(p, null);
    expect(r?.segmentLabel).toBe("West × Online");
    expect(r?.additionalFilters).toEqual([{ column: "channel", value: "Online" }]);
  });
});

describe("lineClickRecord — point vs x-slice datum", () => {
  it("reads x from a single point datum, keyed by the real x column", () => {
    const rec = lineClickRecord({ data: { x: "2025-05" } }, "month");
    expect(rec).toEqual({ month: "2025-05", [CLICK_PRIMARY]: "2025-05" });
  });

  it("reads x from the first point of an x-slice datum", () => {
    const rec = lineClickRecord(
      { points: [{ data: { x: "2025-06" } }, { data: { x: "2025-06" } }] },
      "month"
    );
    expect(rec).toEqual({ month: "2025-06", [CLICK_PRIMARY]: "2025-06" });
  });

  it("preserves numeric x", () => {
    expect(lineClickRecord({ data: { x: 2025 } }, "year")).toEqual({
      year: 2025,
      [CLICK_PRIMARY]: 2025,
    });
  });

  it("returns null when no x is present", () => {
    expect(lineClickRecord({ data: {} }, "month")).toBeNull();
    expect(lineClickRecord({ points: [] }, "month")).toBeNull();
  });

  it("feeds resolveDrillValues so a line drill resolves the clicked x", () => {
    const rec = lineClickRecord({ data: { x: "2025-05" } }, "month");
    const p = {
      segment_label: "Month",
      segment_value: "",
      chart_title: null,
      x_key: "month",
      y_key: "revenue",
      filter_column: "month",
      filter_value: { $item: "month" },
      additional_filters: null,
    } as unknown as DrillDownParams;
    const r = resolveDrillValues(p, rec);
    expect(r?.filterValue).toBe("2025-05");
    expect(r?.segmentLabel).toBe("2025-05");
  });
});

describe("featureClickRecord — map feature properties", () => {
  it("captures scalar properties by real name and resolves filter_column", () => {
    const rec = featureClickRecord({ state: "California", abbr: "CA", pop: 39000000 });
    expect(rec).toMatchObject({ state: "California", abbr: "CA", pop: 39000000 });
    const p = {
      segment_label: "State",
      segment_value: "",
      chart_title: null,
      x_key: null,
      y_key: null,
      filter_column: "state",
      filter_value: { $item: "state" },
      additional_filters: null,
    } as unknown as DrillDownParams;
    expect(resolveDrillValues(p, rec)?.filterValue).toBe("California");
  });

  it("uses a name-like property as the primary fallback", () => {
    const rec = featureClickRecord({ NAME: "Texas", FIPS: 48 });
    expect(rec?.[CLICK_PRIMARY]).toBe("Texas");
  });

  it("drops non-scalar properties and returns null when none remain", () => {
    expect(featureClickRecord({ geometry: { type: "Polygon" }, bbox: [0, 1] })).toBeNull();
  });
});

describe("resolveDrillValues — multi-dimensional clicks (line/scatter 2-D)", () => {
  it("resolves the primary via filter_column and a second dim via additional_filters", () => {
    // A multi-series line: clicked the West series at month 2025-05.
    const p = params({
      filter_value: { $item: "region" },
      filter_column: "region",
      additional_filters: [
        { column: "month", value: { $item: "month" } } as unknown as {
          column: string;
          value: string | number;
        },
      ],
    });
    const r = resolveDrillValues(
      p,
      clicked({ region: "West", month: "2025-05", [CLICK_PRIMARY]: "West" })
    );
    expect(r?.filterValue).toBe("West");
    expect(r?.additionalFilters).toEqual([{ column: "month", value: "2025-05" }]);
  });

  it("drops an additional filter that can't be resolved", () => {
    const p = params({
      filter_value: { $item: "region" },
      additional_filters: [
        { column: "channel", value: { $item: "channel" } } as unknown as {
          column: string;
          value: string | number;
        },
      ],
    });
    const r = resolveDrillValues(p, clicked({ region: "West", [CLICK_PRIMARY]: "West" }));
    expect(r?.filterValue).toBe("West");
    expect(r?.additionalFilters).toEqual([]);
  });
});

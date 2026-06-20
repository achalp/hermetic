import { describe, it, expect } from "vitest";
import { rehydrateSpec } from "@/lib/saved/rehydrate-spec";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { SandboxExecutionResult } from "@/lib/types";

function makeResult(over: Partial<SandboxExecutionResult> = {}): SandboxExecutionResult {
  return {
    success: true,
    results: {},
    chart_data: {},
    images: {},
    datasets: {},
    execution_ms: 1,
    ...over,
  };
}

function makeArtifacts(over: Partial<CachedArtifacts> = {}): CachedArtifacts {
  return {
    code: "",
    question: "",
    results: {},
    chart_data: {},
    datasets: {},
    execution_ms: 0,
    ...over,
  };
}

describe("rehydrateSpec", () => {
  it("returns the cloned spec unchanged when there is no state", () => {
    const saved = { root: "r", elements: {} };
    const out = rehydrateSpec(saved, undefined, makeResult());
    expect(out).toEqual(saved);
    // It is a clone, not the same reference (JSON round-trip).
    expect(out).not.toBe(saved);
  });

  it("does not mutate the input spec", () => {
    const saved = {
      state: { datasets: { main: [{ a: 1 }] } },
      elements: {},
    };
    const before = JSON.stringify(saved);
    rehydrateSpec(saved, undefined, makeResult({ datasets: { main: [{ a: 99 }] } }));
    expect(JSON.stringify(saved)).toBe(before);
  });

  describe("DataController specs", () => {
    it("replaces state.datasets.main from the new result and ignores element props", () => {
      const saved = {
        state: { datasets: { main: [{ old: true }] } },
        elements: {
          dc: { type: "DataController", props: { value: "stale" } },
        },
      };
      const newMain = [{ fresh: 1 }, { fresh: 2 }];
      const out = rehydrateSpec(
        saved,
        makeArtifacts({ results: { v: "stale" } }),
        makeResult({ datasets: { main: newMain } })
      );
      const state = out.state as { datasets: { main: unknown } };
      expect(state.datasets.main).toEqual(newMain);
      // Props left untouched because DataController recomputes on mount.
      const els = out.elements as Record<string, { props: Record<string, unknown> }>;
      expect(els.dc.props.value).toBe("stale");
    });

    it("leaves datasets.main unchanged if the new result has no main dataset", () => {
      const saved = {
        state: { datasets: { main: [{ old: true }] } },
        elements: { dc: { type: "DataController", props: {} } },
      };
      const out = rehydrateSpec(saved, undefined, makeResult({ datasets: {} }));
      const state = out.state as { datasets: { main: unknown } };
      expect(state.datasets.main).toEqual([{ old: true }]);
    });
  });

  describe("non-DataController specs", () => {
    it("replaces matching scalar element props from old → new results", () => {
      const oldArtifacts = makeArtifacts({ results: { total: 100 } });
      const saved = {
        state: { datasets: { main: [] } },
        elements: {
          card: { type: "StatCard", props: { value: 100, label: "Total" } },
        },
      };
      const out = rehydrateSpec(saved, oldArtifacts, makeResult({ results: { total: 250 } }));
      const els = out.elements as Record<string, { props: Record<string, unknown> }>;
      expect(els.card.props.value).toBe(250);
      // Non-matching props untouched.
      expect(els.card.props.label).toBe("Total");
    });

    it("replaces matching chart_data props via deep equality", () => {
      const oldChart = [{ x: "a", y: 1 }];
      const newChart = [{ x: "a", y: 9 }];
      const oldArtifacts = makeArtifacts({ chart_data: { series: oldChart } });
      const saved = {
        state: { datasets: { main: [] } },
        elements: {
          chart: { type: "BarChart", props: { data: [{ x: "a", y: 1 }] } },
        },
      };
      const out = rehydrateSpec(
        saved,
        oldArtifacts,
        makeResult({ chart_data: { series: newChart } })
      );
      const els = out.elements as Record<string, { props: Record<string, unknown> }>;
      expect(els.chart.props.data).toEqual(newChart);
    });

    it("does not replace props that don't match any old artifact value", () => {
      const oldArtifacts = makeArtifacts({ results: { total: 100 } });
      const saved = {
        state: { datasets: { main: [] } },
        elements: {
          card: { type: "StatCard", props: { value: 7 } },
        },
      };
      const out = rehydrateSpec(saved, oldArtifacts, makeResult({ results: { total: 250 } }));
      const els = out.elements as Record<string, { props: Record<string, unknown> }>;
      expect(els.card.props.value).toBe(7);
    });

    it("updates datasets.main even for non-DataController specs", () => {
      const saved = {
        state: { datasets: { main: [{ old: 1 }] } },
        elements: { card: { type: "StatCard", props: {} } },
      };
      const newMain = [{ new: 2 }];
      const out = rehydrateSpec(saved, undefined, makeResult({ datasets: { main: newMain } }));
      const state = out.state as { datasets: { main: unknown } };
      expect(state.datasets.main).toEqual(newMain);
    });

    it("skips prop replacement when oldArtifacts is undefined", () => {
      const saved = {
        state: { datasets: { main: [] } },
        elements: { card: { type: "StatCard", props: { value: 100 } } },
      };
      const out = rehydrateSpec(saved, undefined, makeResult({ results: { total: 250 } }));
      const els = out.elements as Record<string, { props: Record<string, unknown> }>;
      expect(els.card.props.value).toBe(100);
    });
  });
});

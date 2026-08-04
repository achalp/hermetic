// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCurrentAnalysis } from "@/hooks/use-current-analysis";
import type { Spec } from "@/lib/contracts/spec";

// These tests encode the invariants the old workaround comments protected
// (modularization M5-5e / implementation-plan §1.5: comments -> tests before
// deleting the workarounds).

const specA = { root: "a", elements: {} } as Spec;
const specB = { root: "b", elements: {} } as Spec;

function mount(init?: Partial<Parameters<typeof useCurrentAnalysis>[0]>) {
  return renderHook(
    (props: Parameters<typeof useCurrentAnalysis>[0]) => useCurrentAnalysis(props),
    {
      initialProps: {
        loadedSpec: null,
        currentQuestion: null,
        isAnalyzing: false,
        ...init,
      },
    }
  );
}

describe("useCurrentAnalysis (M5-5e)", () => {
  it("a completed stream feeds the save/export refs — the 'Save silently no-ops for fresh streams' bug", () => {
    const { result } = mount();
    expect(result.current.specRef.current).toBeNull();
    act(() => result.current.complete(specA, "q1"));
    // The refs consumers (useSaveExport, slides export) see the fresh spec
    // WITHOUT any hand-rolled sync in a render callback.
    expect(result.current.specRef.current).toBe(specA);
    expect(result.current.questionRef.current).toBe("q1");
    expect(result.current.freshSpec).toBe(specA);
  });

  it("loading a saved viz replaces the analysis (old currentSpecRef effect)", () => {
    const { result, rerender } = mount();
    act(() => result.current.complete(specA, "q1"));
    rerender({ loadedSpec: specB, currentQuestion: "loaded-q", isAnalyzing: false });
    expect(result.current.spec).toBe(specB);
    expect(result.current.questionRef.current).toBe("loaded-q");
    // A load is not a fresh stream — follow-up suggestions must not fire.
    expect(result.current.freshSpec).toBeNull();
  });

  it("starting a new analysis clears the fresh spec so stale follow-ups don't linger", () => {
    const { result, rerender } = mount();
    act(() => result.current.complete(specA, "q1"));
    expect(result.current.freshSpec).toBe(specA);
    rerender({ loadedSpec: null, currentQuestion: null, isAnalyzing: true });
    expect(result.current.freshSpec).toBeNull();
  });

  it("clearing loadedSpec clears the analysis (viz switch)", () => {
    const { result, rerender } = mount({ loadedSpec: specA, currentQuestion: "q" });
    expect(result.current.spec).toBe(specA);
    rerender({ loadedSpec: null, currentQuestion: null, isAnalyzing: false });
    expect(result.current.spec).toBeNull();
    expect(result.current.specRef.current).toBeNull();
  });
});

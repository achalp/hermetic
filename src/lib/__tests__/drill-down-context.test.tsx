// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import React from "react";
import {
  DrillClickContext,
  DrillDownDispatchContext,
  useDrillClickRef,
  useDrillDispatch,
  type DrillClickRef,
} from "@/lib/drill-down-context";
import type { DrillDownParams } from "@/lib/contracts/spec-types";

afterEach(() => cleanup());

describe("drill contexts (M5-5b)", () => {
  it("useDrillDispatch is null outside a SpecView (drill not wired)", () => {
    const { result } = renderHook(() => useDrillDispatch());
    expect(result.current).toBeNull();
  });

  it("useDrillDispatch returns the provided dispatch", () => {
    const calls: DrillDownParams[] = [];
    const dispatch = (p: DrillDownParams) => calls.push(p);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DrillDownDispatchContext.Provider value={dispatch}>
        {children}
      </DrillDownDispatchContext.Provider>
    );
    const { result } = renderHook(() => useDrillDispatch(), { wrapper });
    result.current?.({ filter_column: "c" } as DrillDownParams);
    expect(calls).toHaveLength(1);
  });

  it("useDrillClickRef isolates click records per provider instance", () => {
    const refA: DrillClickRef = { current: null };
    const refB: DrillClickRef = { current: null };
    const wrap = (ref: DrillClickRef) =>
      function Wrapper({ children }: { children: React.ReactNode }) {
        return <DrillClickContext.Provider value={ref}>{children}</DrillClickContext.Provider>;
      };
    const a = renderHook(() => useDrillClickRef(), { wrapper: wrap(refA) });
    const b = renderHook(() => useDrillClickRef(), { wrapper: wrap(refB) });
    a.result.current.current = { region: "West" };
    expect(refA.current).toEqual({ region: "West" });
    expect(refB.current).toBeNull();
    expect(b.result.current.current).toBeNull();
  });
});

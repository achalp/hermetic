// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import React, { useRef } from "react";
import {
  DrillDownContext,
  drillDownCallbackRef,
  useDrillDownCallback,
} from "@/lib/drill-down-context";
import type { DrillDownParams } from "@/lib/types";

afterEach(() => {
  cleanup();
  drillDownCallbackRef.current = null;
});

describe("drillDownCallbackRef", () => {
  it("starts as null", () => {
    expect(drillDownCallbackRef.current).toBeNull();
  });

  it("can be set and invoked", () => {
    let captured: DrillDownParams | null = null;
    drillDownCallbackRef.current = (params) => {
      captured = params;
    };

    const params: DrillDownParams = {
      filter_column: "region",
      filter_value: "West",
      segment_label: "West Region",
      segment_value: "West",
      chart_title: "Sales by Region",
      x_key: "region",
      y_key: "sales",
    };
    drillDownCallbackRef.current!(params);

    expect(captured).toEqual(params);
  });

  it("can be cleared", () => {
    drillDownCallbackRef.current = () => {};
    drillDownCallbackRef.current = null;
    expect(drillDownCallbackRef.current).toBeNull();
  });
});

describe("useDrillDownCallback", () => {
  it("returns the default context value when no provider is present", () => {
    const { result } = renderHook(() => useDrillDownCallback());
    expect(result.current.current).toBeNull();
  });

  it("returns provided ref from DrillDownContext.Provider", () => {
    const callback = (_p: DrillDownParams) => {};

    function Wrapper({ children }: { children: React.ReactNode }) {
      const ref = useRef<((params: DrillDownParams) => void) | null>(callback);
      return <DrillDownContext.Provider value={ref}>{children}</DrillDownContext.Provider>;
    }

    const { result } = renderHook(() => useDrillDownCallback(), {
      wrapper: Wrapper,
    });

    expect(result.current.current).toBe(callback);
  });
});

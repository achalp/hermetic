"use client";

import { createContext, useContext, type MutableRefObject } from "react";
import type { DrillDownParams } from "@/lib/types";

type DrillDownCallback = ((params: DrillDownParams) => void) | null;

/**
 * Module-level ref for the drill-down callback.
 * Used by the registry action (non-React code) to invoke drill-downs.
 * ResponsePanel sets this via useEffect on mount.
 */
export const drillDownCallbackRef: { current: DrillDownCallback } = {
  current: null,
};

/**
 * Context that holds a ref to the drill-down callback.
 * React components use this via useDrillDownCallback() hook.
 */
export const DrillDownContext = createContext<MutableRefObject<DrillDownCallback>>({
  current: null,
});

export function useDrillDownCallback(): MutableRefObject<DrillDownCallback> {
  return useContext(DrillDownContext);
}

"use client";

import { createContext, useContext, type MutableRefObject } from "react";
import type { DrillDownParams } from "@/lib/types";
import type { ClickedRecord } from "@/lib/drill-resolve";

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
 * The dimension values of the most recently clicked chart mark, keyed by real
 * dataset column (plus the {@link CLICK_PRIMARY} sentinel for the primary
 * value). Charts can't resolve json-render `{"$item": ...}` bindings — they
 * aren't list/repeater contexts — so a drill action's `filter_value` would
 * otherwise stay unresolved. The chart sets this on click; the drill callback
 * passes it to `resolveDrillValues`. Reset to null after each drill.
 */
export const drillClickValueRef: { current: ClickedRecord } = { current: null };

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

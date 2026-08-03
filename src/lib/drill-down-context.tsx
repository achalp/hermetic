"use client";

import { createContext, useContext } from "react";
import type { DrillDownParams } from "@/lib/contracts/spec-types";
import type { ClickedRecord } from "@/lib/drill-resolve";

/**
 * Drill-down plumbing (modularization M5-5b).
 *
 * Two contexts, both provided per-<SpecView> (components/spec-view.tsx):
 *
 * - DrillClickContext — the clicked mark's dimension values. Charts can't
 *   resolve json-render `{"$item": ...}` bindings (they aren't list/repeater
 *   contexts), so each chart records its click here and the drill dispatch
 *   resolves the binding against it.
 * - DrillDownDispatchContext — the drill trigger. Chart clicks reach it via
 *   the registry's drillDown action; PivotTable cells and the selection bar
 *   call it directly with concrete (already-resolved) params.
 *
 * Previously TWO module-level mutable refs wired this: a second mounted
 * panel overwrote the first's callback, and unmount nulled it for both.
 * Multiple mounted panels are now legal.
 */

export interface DrillClickRef {
  current: ClickedRecord;
}

// Shared fallback for charts rendered outside a <SpecView> (tests) — one
// shared slot, exactly the pre-M5 behavior.
const fallbackClickRef: DrillClickRef = { current: null };

export const DrillClickContext = createContext<DrillClickRef>(fallbackClickRef);

/** The click-record slot of the nearest <SpecView>. Charts write; dispatch reads. */
export function useDrillClickRef(): DrillClickRef {
  return useContext(DrillClickContext);
}

export type DrillDispatch = ((params: DrillDownParams) => void) | null;

export const DrillDownDispatchContext = createContext<DrillDispatch>(null);

/** The nearest <SpecView>'s drill trigger — null when drill-down isn't wired. */
export function useDrillDispatch(): DrillDispatch {
  return useContext(DrillDownDispatchContext);
}

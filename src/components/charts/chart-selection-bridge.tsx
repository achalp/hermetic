"use client";

import { useStateStore, useStateValue } from "@/spec/react";
import { useCallback, useMemo, type ReactNode } from "react";

interface SelectsConfig {
  column: string;
  bindTo: string;
}

interface SelectionContext {
  /** All currently-selected categories for this dimension (multi-select). */
  selectedValues: string[];
  /** Toggle membership of a category in the selection. */
  onSelect: (value: string) => void;
}

/** Reduce a `/filters/<col>` value to the list of selected categories. */
function normalizeSelected(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).filter((v) => v !== "" && v !== "All");
  }
  if (typeof raw === "number") return [String(raw)];
  if (typeof raw === "string") return raw === "" || raw === "All" ? [] : [raw];
  return [];
}

export function ChartSelectionBridge({
  selects,
  children,
}: {
  selects: SelectsConfig;
  children: (ctx: SelectionContext) => ReactNode;
}) {
  const store = useStateStore();
  const raw = useStateValue<unknown>(selects.bindTo);
  const selectedValues = useMemo(() => normalizeSelected(raw), [raw]);

  const onSelect = useCallback(
    (value: string) => {
      // Multi-select: toggle membership. Empty selection resets to "All".
      const next = selectedValues.includes(value)
        ? selectedValues.filter((v) => v !== value)
        : [...selectedValues, value];
      store.set(selects.bindTo, next.length === 0 ? "All" : next);
    },
    [store, selectedValues, selects.bindTo]
  );

  return <>{children({ selectedValues, onSelect })}</>;
}

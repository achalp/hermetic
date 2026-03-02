"use client";

import { useStateStore, useStateValue } from "@json-render/react";
import { useCallback, useRef, type ReactNode } from "react";

interface SelectsConfig {
  column: string;
  bindTo: string;
}

interface SelectionContext {
  selectedValue: string | null;
  onSelect: (value: string) => void;
}

export function ChartSelectionBridge({
  selects,
  children,
}: {
  selects: SelectsConfig;
  children: (ctx: SelectionContext) => ReactNode;
}) {
  const store = useStateStore();
  const currentValue = useStateValue<string>(selects.bindTo);
  const selectedValue =
    currentValue && currentValue !== "All" ? currentValue : null;

  const storeSetRef = useRef(store.set);
  storeSetRef.current = store.set;

  const onSelect = useCallback(
    (value: string) => {
      // Toggle: clicking the same value deselects (resets to "All")
      storeSetRef.current(
        selects.bindTo,
        value === selectedValue ? "All" : value
      );
    },
    [selectedValue, selects.bindTo]
  );

  return <>{children({ selectedValue, onSelect })}</>;
}

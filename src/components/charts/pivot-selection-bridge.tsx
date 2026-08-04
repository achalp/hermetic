"use client";

import { useStateStore, useStateValue } from "@/spec/react";
import { useCallback, type ReactNode } from "react";

interface SelectsConfig {
  column: string;
  bindTo: string;
}

export interface PivotSelectionContext {
  selectedRow: string | null;
  selectedCol: string | null;
  onSelectRow: ((value: string) => void) | null;
  onSelectCol: ((value: string) => void) | null;
}

/**
 * Bridge between PivotTable's two header-click axes and JSON-Render state.
 * Mirrors ChartSelectionBridge's toggle behavior — clicking the same value
 * twice clears the filter back to "All".
 *
 * Either or both of selectsRow / selectsCol may be set. When neither is
 * provided, the bridge passes nulls through and the component renders
 * non-clickable headers.
 */
export function PivotSelectionBridge({
  selectsRow,
  selectsCol,
  children,
}: {
  selectsRow?: SelectsConfig | null;
  selectsCol?: SelectsConfig | null;
  children: (ctx: PivotSelectionContext) => ReactNode;
}) {
  const store = useStateStore();
  const rawRow = useStateValue<string>(selectsRow?.bindTo ?? "/__pivot_row_unused");
  const rawCol = useStateValue<string>(selectsCol?.bindTo ?? "/__pivot_col_unused");

  const selectedRow = selectsRow && rawRow && rawRow !== "All" ? rawRow : null;
  const selectedCol = selectsCol && rawCol && rawCol !== "All" ? rawCol : null;

  const onSelectRow = useCallback(
    (value: string) => {
      if (!selectsRow) return;
      store.set(selectsRow.bindTo, value === selectedRow ? "All" : value);
    },
    [store, selectsRow, selectedRow]
  );

  const onSelectCol = useCallback(
    (value: string) => {
      if (!selectsCol) return;
      store.set(selectsCol.bindTo, value === selectedCol ? "All" : value);
    },
    [store, selectsCol, selectedCol]
  );

  return (
    <>
      {children({
        selectedRow,
        selectedCol,
        onSelectRow: selectsRow ? onSelectRow : null,
        onSelectCol: selectsCol ? onSelectCol : null,
      })}
    </>
  );
}

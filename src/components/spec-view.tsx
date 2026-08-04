"use client";

import { useMemo, useRef, useCallback, type ReactNode } from "react";
import { StateProvider, ActionProvider, VisibilityProvider, Renderer } from "@/spec/react";
import type { Spec } from "@/lib/contracts/spec";
import type { DrillDownParams } from "@/lib/contracts/spec-types";
import type { ClickedRecord } from "@/lib/drill-resolve";
import {
  registry,
  registryActionHandlers,
  makeRegistryActionHandlers,
} from "@/components/registry";
import { CitationsContext } from "@/components/registry-primitives";
import { RendererErrorBoundary } from "@/components/renderer-error-boundary";
import {
  DrillClickContext,
  DrillDownDispatchContext,
  type DrillClickRef,
} from "@/lib/drill-down-context";

/**
 * THE renderer entry point (modularization M5-5a). Before this component the
 * provider stack (Citations → State → Action → Visibility → ErrorBoundary →
 * Renderer) was hand-assembled at five call sites, inconsistently — the
 * test-spec page forgot the error boundary, and consumers had to know the
 * nesting order. Render a spec with:
 *
 *   <SpecView spec={spec} />
 *
 * Drill-down wiring (M5-5b): pass onDrillDown to receive chart drills. The
 * callback gets the raw action params PLUS the clicked mark's dimension
 * values (charts record them per-SpecView via DrillClickContext), replacing
 * the two module-level mutable refs that limited the app to one mounted
 * panel.
 */
export interface SpecViewProps {
  spec: Spec;
  /** Investigate-mode step-citation superscripts in narrative text. */
  citations?: boolean;
  /** Streaming passthrough to the Renderer. */
  loading?: boolean;
  /**
   * Receives chart/table drills. `clicked` carries the clicked mark's
   * dimension values for `{"$item": ...}` binding resolution (null for
   * sources that pass concrete values, e.g. PivotTable cells).
   */
  onDrillDown?: (params: DrillDownParams, clicked: ClickedRecord) => void;
  /** Rendered inside StateProvider, above the renderer (e.g. SelectionDrillBar). */
  toolbar?: ReactNode;
  /** Wrap the renderer in a data-slides-root div (Slides export segmentation). */
  slidesRoot?: boolean;
}

export function SpecView({
  spec,
  citations = false,
  loading,
  onDrillDown,
  toolbar,
  slidesRoot = false,
}: SpecViewProps) {
  const clickRef = useRef<ClickedRecord>(null) as DrillClickRef;

  const dispatch = useCallback(
    (params: DrillDownParams) => {
      if (!onDrillDown) return;
      const clicked = clickRef.current;
      clickRef.current = null;
      onDrillDown(params, clicked);
    },
    [onDrillDown, clickRef]
  );

  const handlers = useMemo(
    () => (onDrillDown ? makeRegistryActionHandlers(dispatch) : registryActionHandlers),
    [onDrillDown, dispatch]
  );

  const content = (
    <RendererErrorBoundary>
      {slidesRoot ? (
        <div data-slides-root>
          <Renderer spec={spec} registry={registry} loading={loading} />
        </div>
      ) : (
        <Renderer spec={spec} registry={registry} loading={loading} />
      )}
    </RendererErrorBoundary>
  );

  return (
    <CitationsContext.Provider value={citations}>
      <DrillClickContext.Provider value={clickRef}>
        <DrillDownDispatchContext.Provider value={onDrillDown ? dispatch : null}>
          <StateProvider initialState={spec.state ?? {}}>
            {toolbar}
            <ActionProvider handlers={handlers}>
              <VisibilityProvider>{content}</VisibilityProvider>
            </ActionProvider>
          </StateProvider>
        </DrillDownDispatchContext.Provider>
      </DrillClickContext.Provider>
    </CitationsContext.Provider>
  );
}

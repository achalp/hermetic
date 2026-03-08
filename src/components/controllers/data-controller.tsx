"use client";

import { useStateStore, useStateValue } from "@json-render/react";
import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode } from "react";
import {
  applyFilter,
  executePipeline,
  formatOutput,
  computeFilterOptions,
  filterGeoJSON,
  filterGlobeData,
  filterSankeyData,
  type FilterDef,
  type PipelineStep,
  type OutputDef,
} from "@/lib/pipeline/client-pipeline";

type Row = Record<string, unknown>;

export interface DataControllerProps {
  source: {
    statePath?: string;
    fromState?: Record<string, string>;
  };
  filters: FilterDef[];
  pipeline: Record<string, unknown>[];
  outputs: OutputDef[];
}

interface DataControllerComponentProps {
  props: DataControllerProps;
  children?: ReactNode;
}

/**
 * Reads a dataset from state, runs the client pipeline reactively on
 * filter changes, and writes computed results back to state.
 * Renders filter dropdowns + children.
 *
 * Two source modes:
 * 1. source.statePath — reads an existing dataset array from state (dashboard filtering)
 * 2. source.fromState — builds a single-row dataset from scalar state paths (scenario planners)
 */
export function DataControllerComponent({ props, children }: DataControllerComponentProps) {
  const store = useStateStore();
  const isFromState = !!props.source.fromState;
  const datasetFromPath = useStateValue<Row[]>(props.source.statePath ?? "/__unused");

  // Keep a stable ref to store.set so effects that write to the store
  // don't list `store` as a dependency (which changes on every state
  // update and would cause infinite effect → set → re-render loops).
  const storeSetRef = useRef(store.set);
  storeSetRef.current = store.set;

  // ── Stabilize props ───────────────────────────────────────────────
  const filtersJson = JSON.stringify(props.filters);
  const filters = useMemo<FilterDef[]>(
    () => props.filters,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtersJson]
  );

  const pipelineJson = JSON.stringify(props.pipeline);
  const pipelineSteps = useMemo<PipelineStep[]>(
    () => props.pipeline as unknown as PipelineStep[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pipelineJson]
  );

  const outputsJson = JSON.stringify(props.outputs);
  const outputs = useMemo<OutputDef[]>(
    () => props.outputs,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outputsJson]
  );

  // Stabilize fromState mapping
  const fromStateJson = JSON.stringify(props.source.fromState);
  const fromStateMap = useMemo(
    () => props.source.fromState,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromStateJson]
  );

  // ── fromState mode: read scalar state paths into a single-row dataset ──
  const fromStatePaths = useMemo(
    () => (fromStateMap ? Object.entries(fromStateMap) : []),
    [fromStateMap]
  );
  // Read every scalar value so React re-renders when any input changes
  const fromStateValues = fromStatePaths.map(([, path]) => store.get(path));

  const fromStateDataset = useMemo(() => {
    if (!fromStateMap || fromStatePaths.length === 0) return null;
    const row: Row = {};
    for (let i = 0; i < fromStatePaths.length; i++) {
      const [col] = fromStatePaths[i];
      row[col] = fromStateValues[i];
    }
    return [row];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromStateMap, fromStatePaths, ...fromStateValues]);

  // Choose the active dataset based on source mode
  const dataset = isFromState ? fromStateDataset : datasetFromPath;

  // Track filter values in local state so that writing pipeline outputs
  // back to the store does NOT cause re-render loops.
  const [filterValues, setFilterValues] = useState<Record<string, unknown>>(() => {
    const vals: Record<string, unknown> = {};
    for (const f of filters) {
      vals[f.key] = store.get(f.bindTo);
    }
    return vals;
  });

  // Sync external writes to filter state paths (e.g. from chart cross-filtering)
  // into local filterValues. Only calls setFilterValues on genuine mismatch to
  // avoid infinite loops. Terminates within 3 renders.
  useEffect(() => {
    let changed = false;
    const updates: Record<string, unknown> = {};
    for (const def of filters) {
      const storeVal = store.get(def.bindTo);
      if (storeVal !== filterValues[def.key]) {
        updates[def.key] = storeVal;
        changed = true;
      }
    }
    if (changed) setFilterValues((prev) => ({ ...prev, ...updates }));
  }, [store, filters, filterValues]);

  // Compute filter options (respecting cascading)
  const filterOptions = useMemo(() => {
    if (!Array.isArray(dataset) || dataset.length === 0) return {};
    return computeFilterOptions(dataset, filters, filterValues);
  }, [dataset, filters, filterValues]);

  // Run shared pipeline (used by outputs that don't define their own)
  const sharedPipelineResult = useMemo(() => {
    if (!Array.isArray(dataset) || dataset.length === 0) return [];
    return executePipeline(dataset, pipelineSteps, filterValues, filters);
  }, [dataset, pipelineSteps, filterValues, filters]);

  // Filtered dataset (shared filter step only) — used as the base for
  // per-output pipelines so each output can run its own aggregation.
  const filteredData = useMemo(() => {
    if (!Array.isArray(dataset) || dataset.length === 0) return [];
    return applyFilter(dataset, filterValues, filters);
  }, [dataset, filterValues, filters]);

  // Write outputs to state. Each output either uses its own pipeline
  // (run on the filtered data) or falls back to the shared pipeline result.
  // Pattern A outputs (geojson, globeData, sankeyData) read structured data
  // from a separate state path, filter it, and write the result.
  useEffect(() => {
    if (!Array.isArray(dataset) || dataset.length === 0) return;
    for (const output of outputs) {
      // Pattern A: filter structured data directly from state
      if (
        output.sourceStatePath &&
        (output.format === "geojson" ||
          output.format === "globeData" ||
          output.format === "sankeyData")
      ) {
        const sourceData = store.get(output.sourceStatePath);
        if (sourceData && typeof sourceData === "object") {
          let filtered: unknown;
          if (output.format === "geojson") {
            filtered = filterGeoJSON(sourceData as Record<string, unknown>, filterValues, filters);
          } else if (output.format === "globeData") {
            filtered = filterGlobeData(
              sourceData as Record<string, unknown>,
              filterValues,
              filters
            );
          } else {
            filtered = filterSankeyData(
              sourceData as Record<string, unknown>,
              filterValues,
              filters
            );
          }
          storeSetRef.current(output.statePath, filtered);
        }
        continue;
      }

      // Normal pipeline path (including Pattern B matrix/chordMatrix formats)
      const outputPipeline = output.pipeline as unknown as PipelineStep[] | null | undefined;
      let data: Record<string, unknown>[];
      if (outputPipeline && outputPipeline.length > 0) {
        // Run this output's own pipeline on the filtered dataset
        data = executePipeline(filteredData, outputPipeline, filterValues, filters);
      } else {
        data = sharedPipelineResult;
      }
      const formatted = formatOutput(data, output);
      storeSetRef.current(output.statePath, formatted);
    }
  }, [sharedPipelineResult, filteredData, dataset, outputs, filterValues, filters, store]);

  // Reset child filter values when parent changes make them invalid
  useEffect(() => {
    for (const def of filters) {
      if (!def.dependsOn || def.dependsOn.length === 0) continue;
      const currentVal = filterValues[def.key];
      if (currentVal && currentVal !== "All") {
        const options = filterOptions[def.key];
        if (options && !options.includes(String(currentVal))) {
          const resetVal = def.allowAll ? "All" : (options[0] ?? "All");
          storeSetRef.current(def.bindTo, resetVal);
          setFilterValues((prev) => ({ ...prev, [def.key]: resetVal }));
        }
      }
    }
  }, [filterOptions, filters, filterValues]);

  const handleFilterChange = useCallback((def: FilterDef, value: string) => {
    storeSetRef.current(def.bindTo, value);
    setFilterValues((prev) => ({ ...prev, [def.key]: value }));
  }, []);

  // fromState mode or no filters: skip filter dropdowns
  if (isFromState || filters.length === 0) {
    return <>{children}</>;
  }

  return (
    <div className="space-y-4">
      {/* Filter dropdowns */}
      <div className="flex flex-wrap gap-3">
        {filters.map((def) => {
          const options = filterOptions[def.key] ?? [];
          const currentVal = String(filterValues[def.key] ?? (def.allowAll ? "All" : ""));

          return (
            <div key={def.key} className="flex flex-col gap-1">
              <label className="text-sm font-medium text-t-secondary">{def.label}</label>
              <select
                value={currentVal}
                onChange={(e) => handleFilterChange(def, e.target.value)}
                className="border border-border-default bg-surface-input px-3 py-2 text-sm text-t-primary outline-none transition-colors focus:border-accent"
                style={{
                  borderRadius: "var(--radius-input)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                {def.allowAll && <option value="All">All</option>}
                {options.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      {/* Children (charts, tables, etc.) */}
      {children}
    </div>
  );
}

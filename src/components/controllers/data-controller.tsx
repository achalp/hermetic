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
  /**
   * Set when the underlying dataset is a SAMPLE of a larger result (the full
   * data couldn't be shipped to the client). Filtered / per-group figures the
   * client recomputes are then approximate — this renders a visible caveat so
   * the user isn't misled. Injected deterministically by the compose layer.
   */
  sample_note?: string | null;
}

interface DataControllerComponentProps {
  props: DataControllerProps;
  children?: ReactNode;
}

/** A small amber banner warning that filtered figures are based on a sample. */
function SampleCaveat({ note }: { note: string }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      style={{ borderRadius: "var(--radius-input)" }}
    >
      <span aria-hidden="true">⚠</span>
      <span>{note}</span>
    </div>
  );
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
  const storeGetRef = useRef(store.get);
  storeGetRef.current = store.get;
  // Snapshot of the pre-computed output seeds (exact full-data values injected
  // via $chartData). For a SAMPLED dataset we restore these when no filter is
  // active, instead of re-aggregating the truncated sample — see the outputs
  // effect below.
  const seedRef = useRef<Record<string, unknown> | null>(null);

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
  const isSample = !!props.sample_note;
  useEffect(() => {
    if (!Array.isArray(dataset) || dataset.length === 0) return;

    // Snapshot the initial seeds (the exact full-data values pre-populated via
    // $chartData) once, before any recompute can overwrite them.
    if (seedRef.current === null) {
      const seeds: Record<string, unknown> = {};
      for (const o of outputs) {
        const v = storeGetRef.current(o.statePath);
        const nonEmpty = Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null;
        if (nonEmpty) seeds[o.statePath] = v;
      }
      seedRef.current = seeds;
    }

    // Is any filter actually engaged (not "All"/empty)?
    const anyFilterActive = filters.some((f) => {
      const v = filterValues[f.key];
      return v !== undefined && v !== null && v !== "All" && v !== "";
    });

    for (const output of outputs) {
      // SAMPLED data, no active filter: keep the exact pre-computed seed rather
      // than re-aggregating /datasets/main (a truncated sample) — recomputing
      // would silently disagree with the headline figures and can drop
      // Python-derived fields (e.g. a display label). Only recompute on a real
      // filter interaction (the sample caveat warns the user then).
      if (isSample && !anyFilterActive) {
        const seed = seedRef.current?.[output.statePath];
        const nonEmpty = Array.isArray(seed)
          ? seed.length > 0
          : seed !== undefined && seed !== null;
        if (nonEmpty) {
          storeSetRef.current(output.statePath, seed);
          continue;
        }
      }
      // Pattern A: filter structured data directly from state
      if (
        output.sourceStatePath &&
        (output.format === "geojson" ||
          output.format === "globeData" ||
          output.format === "sankeyData")
      ) {
        const sourceData = storeGetRef.current(output.sourceStatePath);
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
  }, [sharedPipelineResult, filteredData, dataset, outputs, filterValues, filters, isSample]);

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

  const sampleNote = props.sample_note?.trim() || null;

  // fromState mode or no filters: skip filter dropdowns (still surface the
  // sample caveat if one was set).
  if (isFromState || filters.length === 0) {
    return (
      <>
        {sampleNote && <SampleCaveat note={sampleNote} />}
        {children}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {sampleNote && <SampleCaveat note={sampleNote} />}
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

import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { SandboxExecutionResult } from "@/lib/types";

/**
 * Clone the saved spec and inject new execution results.
 *
 * DataController specs: only replace state.datasets.main — the DataController
 * recomputes all chart data from the raw dataset on mount.
 *
 * Non-DataController specs: replace values in element props by matching
 * against old artifact values.
 */
export function rehydrateSpec(
  savedSpec: Record<string, unknown>,
  oldArtifacts: CachedArtifacts | undefined,
  newResult: SandboxExecutionResult
): Record<string, unknown> {
  const spec = JSON.parse(JSON.stringify(savedSpec));

  const state = spec.state as Record<string, unknown> | undefined;
  if (!state) return spec;

  const datasets = state.datasets as Record<string, unknown> | undefined;
  const usesDataController = specUsesDataController(spec);

  if (usesDataController) {
    if (datasets && newResult.datasets?.main) {
      datasets.main = newResult.datasets.main;
    }
  } else {
    if (datasets && newResult.datasets?.main) {
      datasets.main = newResult.datasets.main;
    }
    if (oldArtifacts && spec.elements && typeof spec.elements === "object") {
      replaceElementProps(
        spec.elements as Record<string, Record<string, unknown>>,
        oldArtifacts,
        newResult
      );
    }
  }

  return spec;
}

function specUsesDataController(spec: Record<string, unknown>): boolean {
  const elements = spec.elements as Record<string, Record<string, unknown>> | undefined;
  if (!elements || typeof elements !== "object") return false;
  return Object.values(elements).some((el) => el.type === "DataController");
}

function replaceElementProps(
  elements: Record<string, Record<string, unknown>>,
  oldArtifacts: CachedArtifacts,
  newResult: SandboxExecutionResult
): void {
  for (const el of Object.values(elements)) {
    const props = el.props as Record<string, unknown> | undefined;
    if (!props) continue;

    for (const [key, oldVal] of Object.entries(oldArtifacts.results)) {
      for (const [propKey, propVal] of Object.entries(props)) {
        if (propVal === oldVal && key in newResult.results) {
          props[propKey] = newResult.results[key];
        }
      }
    }

    for (const [key, oldData] of Object.entries(oldArtifacts.chart_data)) {
      for (const [propKey, propVal] of Object.entries(props)) {
        if (deepEqual(propVal, oldData) && key in newResult.chart_data) {
          props[propKey] = newResult.chart_data[key];
        }
      }
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

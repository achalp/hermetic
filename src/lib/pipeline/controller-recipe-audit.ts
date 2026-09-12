/**
 * Post-compose baseline replay for DataController recipes (the controller
 * sibling of the declared-series re-aggregation check, spec §14.4).
 *
 * A DataController RE-DERIVES its `/computed/*` outputs from `/datasets/*` on
 * every mount, overwriting the exact Python-derived seeds the composer wrote
 * into initial state. Nothing verified that the LLM-authored recipe actually
 * reproduces those seeds — run 861ef499 shipped a "Latest Year" chart whose
 * recipe aggregated ALL years (16.5% where the analysis said 17.1%), and a
 * vocabulary miss ("mean") blanked every chart. The series path already holds
 * the answer: REPLAY the recipe against the baseline; a recipe that cannot
 * reproduce its own seed is stripped, so the component stays on the correct
 * static values — static beats wrong.
 *
 * Pure and patch-driven (like computed-key-audit) so it is unit-testable; the
 * caller emits the corrective element patches this returns.
 */
import {
  applyFilter,
  executePipeline,
  type PipelineStep,
  type FilterDef,
} from "@/lib/data-transforms/client-pipeline";
import type { PatchLike } from "./computed-key-audit";

type Row = Record<string, unknown>;

interface ControllerOutput {
  statePath?: string;
  format?: string;
  pipeline?: PipelineStep[] | null;
  sourceStatePath?: string;
}

interface ControllerProps {
  source?: { statePath?: string; fromState?: unknown };
  filters?: FilterDef[];
  outputs?: ControllerOutput[];
}

export interface ControllerRecipeFailure {
  elementId: string;
  statePath: string;
  /** The recipe that failed baseline replay. */
  pipeline: PipelineStep[];
  /** The Python-derived seed the recipe must reproduce. */
  seed: Row[];
  /** Consumer-bound columns the replay must carry (empty ⇒ all seed columns). */
  requiredCols: string[];
  /** Source-dataset shape, for a targeted repair prompt. */
  datasetColumns: string[];
  datasetSample: Row[];
  filters: FilterDef[];
}

export interface ControllerRecipeAudit {
  /** Output statePaths whose replay failed, keyed by element id. */
  stripped: { elementId: string; statePath: string }[];
  /** Replacement element patches (same path, outputs filtered) to emit + record. */
  correctedPatches: PatchLike[];
  /** Full per-failure context — what a targeted repair needs. */
  failures: ControllerRecipeFailure[];
}

/** Assemble a nested object from add-patches ("/state", "/state/datasets/main", …). */
function materialize(patches: PatchLike[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const p of patches) {
    if (p.op !== "add" && p.op !== "replace") continue;
    if (typeof p.path !== "string" || !p.path.startsWith("/")) continue;
    const segs = p.path.slice(1).split("/").filter(Boolean);
    if (segs.length === 0) continue;
    let cursor: Record<string, unknown> = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      const next = cursor[s];
      if (!next || typeof next !== "object" || Array.isArray(next)) cursor[s] = {};
      cursor = cursor[s] as Record<string, unknown>;
    }
    const leaf = segs[segs.length - 1]!;
    const existing = cursor[leaf];
    // A nested add under an object merges; anything else replaces.
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      p.value &&
      typeof p.value === "object" &&
      !Array.isArray(p.value)
    ) {
      cursor[leaf] = { ...(existing as object), ...(p.value as object) };
    } else {
      cursor[leaf] = p.value;
    }
  }
  return root;
}

function getAtPath(root: Record<string, unknown>, path: string): unknown {
  const segs = path.replace(/^\//, "").split("/").filter(Boolean);
  let cur: unknown = root;
  for (const s of segs) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/**
 * Approximate scalar equality: numeric values tolerate 1-decimal Python
 * rounding of the seed (abs 0.051) or 1% relative drift (float accumulation);
 * everything else compares as strings — which deliberately lets a numeric
 * 2010 match a seed's "2010" (pandas stringifies group keys).
 */
function valuesMatch(seed: unknown, replayed: unknown): boolean {
  const ns = typeof seed === "boolean" ? NaN : Number(seed);
  const nr = typeof replayed === "boolean" ? NaN : Number(replayed);
  if (
    seed !== "" &&
    replayed !== "" &&
    seed !== null &&
    replayed !== null &&
    Number.isFinite(ns) &&
    Number.isFinite(nr)
  ) {
    return Math.abs(ns - nr) <= Math.max(0.051, Math.abs(ns) * 0.01);
  }
  return String(seed) === String(replayed);
}

/**
 * Does the replayed frame reproduce the seeded frame? Row count must match,
 * and every checked column's sorted multiset of replayed values must match
 * the seed's (order-independent: recipes sort differently than Python did).
 *
 * Checked columns: the ones CONSUMERS bind (x_key/y_keys/…) when the caller
 * derived them — a recipe is free to drop a seed column no element reads
 * (recomputation always loses cosmetic Python-derived fields; stripping for
 * that would cost filter interactivity for nothing). With no consumer info,
 * every seed column is required. Replay-only extra columns are always fine.
 */
export function framesMatch(seed: Row[], replayed: Row[], requiredCols?: string[]): boolean {
  if (seed.length !== replayed.length) return false;
  if (seed.length === 0) return true;
  const seedCols = Object.keys(seed[0]!);
  const cols =
    requiredCols && requiredCols.length > 0
      ? seedCols.filter((c) => requiredCols.includes(c) || c in (replayed[0] ?? {}))
      : seedCols;
  for (const col of cols) {
    if (!(col in (replayed[0] ?? {}))) return false;
    const sortKey = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && v !== "" && v !== null ? n : String(v);
    };
    const bySort = (a: unknown, b: unknown) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      if (typeof ka === "number" && typeof kb === "number") return ka - kb;
      return String(ka).localeCompare(String(kb));
    };
    const sv = seed.map((r) => r[col]).sort(bySort);
    const rv = replayed.map((r) => r[col]).sort(bySort);
    for (let i = 0; i < sv.length; i++) {
      if (!valuesMatch(sv[i], rv[i])) return false;
    }
  }
  return true;
}

/**
 * Replay every rows-format DataController output against its seeded value.
 * Returns the outputs to strip and the corrective element patches. Verifies
 * only what it can prove: outputs with their own pipeline, a rows-shaped
 * seed, and an array dataset — everything else is left untouched.
 */
/** Column names the elements bound to `statePath` actually read (x/y keys …). */
function consumedColumns(elements: Record<string, unknown>, statePath: string): string[] {
  const cols = new Set<string>();
  for (const el of Object.values(elements)) {
    const props = (el as { props?: Record<string, unknown> })?.props;
    if (!props || typeof props !== "object") continue;
    const data = props.data as { $state?: unknown } | undefined;
    if (!data || data.$state !== statePath) continue;
    for (const key of [
      "x_key",
      "labelColumn",
      "valueColumn",
      "groupColumn",
      "xColumn",
      "yColumn",
    ]) {
      if (typeof props[key] === "string") cols.add(props[key] as string);
    }
    if (Array.isArray(props.y_keys)) {
      for (const y of props.y_keys) if (typeof y === "string") cols.add(y);
    }
  }
  return [...cols];
}

export function auditControllerRecipes(patches: PatchLike[]): ControllerRecipeAudit {
  const root = materialize(patches);
  const stripped: ControllerRecipeAudit["stripped"] = [];
  const correctedPatches: PatchLike[] = [];
  const failures: ControllerRecipeFailure[] = [];

  const elements = (root.elements ?? {}) as Record<string, unknown>;
  for (const [elementId, el] of Object.entries(elements)) {
    const type = (el as { type?: unknown })?.type;
    if (type !== "DataController") continue;
    const props = ((el as { props?: unknown }).props ?? {}) as ControllerProps;
    const sourcePath = props.source?.statePath;
    if (!sourcePath || props.source?.fromState) continue;
    const dataset = getAtPath(root, `/state${sourcePath.startsWith("/") ? "" : "/"}${sourcePath}`);
    if (!Array.isArray(dataset) || dataset.length === 0) continue;

    const filters = Array.isArray(props.filters) ? props.filters : [];
    // Mirror the controller's own init: each filter reads its seeded bindTo.
    const filterValues: Record<string, unknown> = {};
    for (const f of filters) {
      if (f?.key && typeof f.bindTo === "string") {
        filterValues[f.key] = getAtPath(root, `/state${f.bindTo}`);
      }
    }
    const filtered = applyFilter(dataset as Row[], filterValues, filters);

    const outputs = Array.isArray(props.outputs) ? props.outputs : [];
    const failing = new Set<string>();
    for (const out of outputs) {
      if (!out?.statePath || typeof out.statePath !== "string") continue;
      if (out.format && out.format !== "rows") continue;
      if (out.sourceStatePath) continue;
      const pipeline = out.pipeline;
      if (!Array.isArray(pipeline) || pipeline.length === 0) continue;
      const seed = getAtPath(root, `/state${out.statePath}`);
      if (!Array.isArray(seed) || seed.length === 0) continue;
      if (!seed.every((r) => r && typeof r === "object" && !Array.isArray(r))) continue;

      let replayed: Row[];
      try {
        replayed = executePipeline(filtered, pipeline, filterValues, filters);
      } catch {
        failing.add(out.statePath);
        continue;
      }
      const required = consumedColumns(elements, out.statePath);
      if (!framesMatch(seed as Row[], replayed, required)) {
        failing.add(out.statePath);
        failures.push({
          elementId,
          statePath: out.statePath,
          pipeline,
          seed: seed as Row[],
          requiredCols: required,
          datasetColumns: Object.keys((dataset[0] ?? {}) as Row),
          datasetSample: (dataset as Row[]).slice(0, 3),
          filters,
        });
      }
    }

    if (failing.size > 0) {
      for (const p of failing) stripped.push({ elementId, statePath: p });
      const fixed = {
        ...(el as Row),
        props: {
          ...(props as Row),
          outputs: outputs.filter((o) => !o?.statePath || !failing.has(o.statePath)),
        },
      };
      correctedPatches.push({ op: "add", path: `/elements/${elementId}`, value: fixed });
    }
  }

  return { stripped, correctedPatches, failures };
}

/**
 * Would `candidate` reproduce the seed where the original recipe failed?
 * Re-materializes from the same patches so the check matches the audit's
 * exact inputs (filter seeding included).
 */
export function validateRecipeRepair(
  patches: PatchLike[],
  failure: ControllerRecipeFailure,
  candidate: PipelineStep[]
): boolean {
  const root = materialize(patches);
  const el = ((root.elements ?? {}) as Record<string, unknown>)[failure.elementId];
  const props = ((el as { props?: unknown })?.props ?? {}) as ControllerProps;
  const sourcePath = props.source?.statePath;
  if (!sourcePath) return false;
  const dataset = getAtPath(root, `/state${sourcePath.startsWith("/") ? "" : "/"}${sourcePath}`);
  if (!Array.isArray(dataset)) return false;
  const filterValues: Record<string, unknown> = {};
  for (const f of failure.filters) {
    if (f?.key && typeof f.bindTo === "string") {
      filterValues[f.key] = getAtPath(root, `/state${f.bindTo}`);
    }
  }
  const filtered = applyFilter(dataset as Row[], filterValues, failure.filters);
  let replayed: Row[];
  try {
    replayed = executePipeline(filtered, candidate, filterValues, failure.filters);
  } catch {
    return false;
  }
  return framesMatch(failure.seed, replayed, failure.requiredCols);
}

/**
 * One corrective element patch applying per-output decisions: a PipelineStep[]
 * REPLACES that output's recipe (validated repair); null DROPS the output
 * (chart stays on its correct static seed).
 */
export function buildControllerCorrection(
  patches: PatchLike[],
  elementId: string,
  decisions: Map<string, PipelineStep[] | null>
): PatchLike | null {
  const root = materialize(patches);
  const el = ((root.elements ?? {}) as Record<string, unknown>)[elementId];
  if (!el || typeof el !== "object") return null;
  const props = ((el as { props?: unknown }).props ?? {}) as ControllerProps;
  const outputs = Array.isArray(props.outputs) ? props.outputs : [];
  const nextOutputs = outputs.flatMap((o) => {
    if (!o?.statePath || !decisions.has(o.statePath)) return [o];
    const d = decisions.get(o.statePath);
    return d === null || d === undefined ? [] : [{ ...o, pipeline: d }];
  });
  return {
    op: "add",
    path: `/elements/${elementId}`,
    value: { ...(el as Row), props: { ...(props as Row), outputs: nextOutputs } },
  };
}

/**
 * Post-compose audit: does every `/computed/<key>` a component READS actually
 * have a PRODUCER? A key is produced by a DataController output (an `outputs`
 * entry whose statePath is that key) or by a non-empty initial seed. A component
 * bound to an unproduced key renders empty (the blank-table/blank-map bug the
 * Seattle spec exhibited: the table read /computed/top_table_rows and the map
 * read /computed/map_markers, but only top_isolated/subtype_dist/stats were
 * produced).
 *
 * This is warn-only — it does not mutate the spec. It surfaces the defect in the
 * server logs so a dropped/empty component is visible and trackable rather than
 * silently shipping. Pure and patch-driven so it is unit-testable.
 */

export interface PatchLike {
  op: string;
  path: string;
  value?: unknown;
}

export interface ComputedKeyAudit {
  referenced: string[];
  produced: string[];
  /** Referenced by a component but produced by nothing — these render empty. */
  unproduced: string[];
}

/** The base key of a `/computed/<key>[/...]` path, else null. */
function computedKeyOf(path: unknown): string | null {
  if (typeof path !== "string") return null;
  const m = /^\/computed\/([^/]+)/.exec(path);
  return m ? m[1] : null;
}

function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  if (typeof v === "string") return v.length > 0;
  return true;
}

/**
 * Audit a composed spec's patch stream for component reads of computed keys that
 * nothing produces.
 */
export function auditComputedKeys(patches: PatchLike[]): ComputedKeyAudit {
  const produced = new Set<string>();
  const referenced = new Set<string>();

  // A DataController element declares producers via props.outputs[].statePath.
  const collectOutputs = (val: unknown): void => {
    if (!val || typeof val !== "object") return;
    const props = (val as { props?: { outputs?: unknown } }).props;
    const outputs = props?.outputs;
    if (Array.isArray(outputs)) {
      for (const o of outputs) {
        const key = computedKeyOf((o as { statePath?: unknown })?.statePath);
        if (key) produced.add(key);
      }
    }
  };

  // Any {"$state": "/computed/<key>"} anywhere in a value is a READ.
  const collectRefs = (val: unknown): void => {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach(collectRefs);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const key = computedKeyOf(obj.$state);
      if (key) referenced.add(key);
      for (const v of Object.values(obj)) collectRefs(v);
    }
  };

  for (const p of patches) {
    // Producer: a /state/computed/<key> add carrying a non-empty seed.
    const seed = /^\/state\/computed\/([^/]+)/.exec(p.path);
    if (seed && isNonEmpty(p.value)) produced.add(seed[1]);
    // Producer: a /state (or /state/computed) add whose value carries a computed map.
    if (
      (p.path === "/state" || p.path === "/state/computed") &&
      p.value &&
      typeof p.value === "object"
    ) {
      const computed =
        p.path === "/state/computed"
          ? (p.value as Record<string, unknown>)
          : ((p.value as { computed?: Record<string, unknown> }).computed ?? {});
      for (const [k, v] of Object.entries(computed)) if (isNonEmpty(v)) produced.add(k);
    }
    collectOutputs(p.value);
    collectRefs(p.value);
  }

  const unproduced = [...referenced].filter((k) => !produced.has(k));
  return { referenced: [...referenced], produced: [...produced], unproduced };
}

/**
 * The `/datasets` sibling of {@link auditComputedKeys}: does every
 * `{"$state": "/datasets/<key>"}` a component reads name a dataset that will
 * exist at runtime?
 *
 * Producers are deterministic here: the pipeline always injects
 * `/state/datasets` with `main` + every chart_data key (`runtimeKeys`), and a
 * spec may seed additional datasets itself. Anything else renders empty — the
 * run-572ff50a failure: a generative spec bound MapView.markers and
 * DataTable.rows to `/datasets/isolated_markers` while the run produced
 * `map_top_isolated_buildings` / `seattle_top10_isolated_buildings`, so the
 * map and table shipped blank with no error anywhere.
 */
export function auditDatasetKeys(
  patches: PatchLike[],
  runtimeKeys: Iterable<string>
): ComputedKeyAudit {
  const produced = new Set<string>(runtimeKeys);
  const referenced = new Set<string>();

  const datasetKeyOf = (path: unknown): string | null => {
    if (typeof path !== "string") return null;
    const m = /^\/datasets\/([^/]+)/.exec(path);
    return m ? m[1] : null;
  };

  const collectRefs = (val: unknown): void => {
    if (!val) return;
    if (Array.isArray(val)) {
      val.forEach(collectRefs);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const key = datasetKeyOf(obj.$state);
      if (key) referenced.add(key);
      for (const v of Object.values(obj)) collectRefs(v);
    }
  };

  for (const p of patches) {
    // Producer: an explicit /state/datasets/<key> seed.
    const seed = /^\/state\/datasets\/([^/]+)/.exec(p.path);
    if (seed && isNonEmpty(p.value)) produced.add(seed[1]);
    // Producer: a /state (or /state/datasets) add whose value carries a datasets map.
    if (
      (p.path === "/state" || p.path === "/state/datasets") &&
      p.value &&
      typeof p.value === "object"
    ) {
      const datasets =
        p.path === "/state/datasets"
          ? (p.value as Record<string, unknown>)
          : ((p.value as { datasets?: Record<string, unknown> }).datasets ?? {});
      for (const [k, v] of Object.entries(datasets)) if (isNonEmpty(v)) produced.add(k);
    }
    collectRefs(p.value);
  }

  const unproduced = [...referenced].filter((k) => !produced.has(k));
  return { referenced: [...referenced], produced: [...produced], unproduced };
}

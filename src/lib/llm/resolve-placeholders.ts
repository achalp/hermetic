/**
 * Server-side resolver for `$result:<key>` and `$chartData:<key>` placeholders
 * in streamed JSONL spec patches. Applied per-line before forwarding to the
 * client. Mirrors the inline implementation in /api/query/route.ts; the
 * investigate route uses it with merged per-step results so placeholders
 * like `$result:step_2_total_revenue` resolve correctly.
 */

import { logger } from "@/lib/logger";
import { recordFailure } from "@/lib/diagnostics/failure-log";

/**
 * Conservatively map a requested chartData key onto one the analysis actually
 * produced, when the composer drifted the name. Only returns a match that is
 * UNAMBIGUOUS — a wrong bind (showing chart A's data under chart B) is worse
 * than a blank chart, so we never guess between candidates.
 *
 *   1. exact after normalizing case / non-alphanumerics
 *   2. unique substring containment (e.g. "revenue" ⊂ "total_revenue")
 *   3. unique high token-overlap (Jaccard ≥ 0.6) — catches reordered tokens
 *
 * Returns undefined when there's no confident, unique match.
 */
function repairChartKey(requested: string, available: string[]): string | undefined {
  if (available.length === 0) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rn = norm(requested);
  if (!rn) return undefined;

  const exact = available.filter((k) => norm(k) === rn);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;

  const contained = available.filter((k) => {
    const kn = norm(k);
    return kn.length > 2 && rn.length > 2 && (kn.includes(rn) || rn.includes(kn));
  });
  if (contained.length === 1) return contained[0];

  const toks = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
    );
  const rt = toks(requested);
  if (rt.size === 0) return undefined;
  let best: { k: string; score: number } | undefined;
  let tie = false;
  for (const k of available) {
    const kt = toks(k);
    if (kt.size === 0) continue;
    const inter = [...rt].filter((t) => kt.has(t)).length;
    const union = new Set([...rt, ...kt]).size;
    const score = union ? inter / union : 0;
    if (!best || score > best.score) {
      best = { k, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  return best && best.score >= 0.6 && !tie ? best.k : undefined;
}

/**
 * Resolve a dot-notation key path against a results object. Greedy: tries the
 * longest matching prefix first so keys containing literal dots
 * (e.g. "significant_at_0.05") resolve as single keys.
 */
function resolveKeyPath(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (path in rec) return rec[path];
  const dot = path.indexOf(".");
  if (dot === -1) return undefined;
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  if (head in rec) return resolveKeyPath(rec[head], tail);
  return undefined;
}

/**
 * Charts want an ARRAY for their data prop, but Python steps sometimes emit
 * wrapper objects: `{rows: [...]}`, or a full chart-config payload
 * `{data: [...], x_key, y_keys}`. Unwrap to the inner rows array when the
 * shape is unambiguous:
 *   - an object with a `data` or `rows` key holding an array → that array
 *   - an object with exactly ONE key whose value is an array → that array
 * Anything else (named-series objects, globe {points, arcs}, treemap trees)
 * is left untouched.
 */
function unwrapChartRows(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.data)) return obj.data;
  if (Array.isArray(obj.rows)) return obj.rows;
  const entries = Object.entries(obj);
  if (entries.length === 1 && Array.isArray(entries[0][1])) return entries[0][1];
  return value;
}

// ── Chart $state binding repair ──────────────────────────────────
// Unlike $result/$chartData, `{"$state":"/computed/<key>"}` bindings are NOT
// resolved server-side — json-render resolves them on the client. So when the
// analysis step writes a table to `/computed/windrose` but the (separately
// generated) compose step binds a chart to `/computed/wind_rose`, nothing
// catches it and the chart renders empty. These helpers repair such bindings
// against the set of keys the analysis actually produced, matching on a
// case/underscore/hyphen-insensitive basis.

export interface ValidStateKeys {
  computed: Set<string>;
  datasets: Set<string>;
}

const normalizeStateKey = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, "");

/**
 * Rewrite a single `/computed/<base>[/...]` or `/datasets/<base>[/...]` path so
 * its base segment matches a produced key when it differs only by
 * case/underscores/hyphens (e.g. "/computed/wind_rose" → "/computed/windrose").
 * Returns the path unchanged when already valid or no normalized match exists.
 */
function repairStatePath(path: string, valid: ValidStateKeys): string {
  const m = /^\/(computed|datasets)\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return path;
  const prefix = m[1] as "computed" | "datasets";
  const base = m[2];
  const rest = m[3] ?? "";
  const set = valid[prefix];
  if (set.size === 0 || set.has(base)) return path;
  const norm = normalizeStateKey(base);
  for (const v of set) {
    if (normalizeStateKey(v) === norm) return `/${prefix}/${v}${rest}`;
  }
  return path;
}

/**
 * Recursively repair `{"$state":"/computed|datasets/..."}` bindings in a
 * streamed patch value so charts read the keys the analysis actually produced.
 * Mutates `value` in place; returns the number of bindings rewritten.
 */
export function repairStateBindings(value: unknown, valid: ValidStateKeys): number {
  let repairs = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$state === "string") {
      const next = repairStatePath(obj.$state, valid);
      if (next !== obj.$state) {
        obj.$state = next;
        repairs++;
      }
    }
    for (const k of Object.keys(obj)) {
      if (k === "$state") continue;
      visit(obj[k]);
    }
  };
  visit(value);
  return repairs;
}

/**
 * Harvest `/computed` and `/datasets` base keys *declared* by a streamed patch
 * (DataController `outputs[].statePath`, `/state` seeds, and direct
 * `/state/<prefix>/<key>` adds) into the valid-key sets, so chart bindings that
 * stream nearby can be matched against them. Mutates `valid` in place.
 */
export function harvestStateKeys(patch: unknown, valid: ValidStateKeys): void {
  if (!patch || typeof patch !== "object") return;
  const p = patch as { path?: unknown; value?: unknown };
  const path = typeof p.path === "string" ? p.path : "";

  const addFromStatePath = (sp: string): void => {
    const m = /^\/(computed|datasets)\/([^/]+)/.exec(sp);
    if (m) valid[m[1] as "computed" | "datasets"].add(m[2]);
  };

  // DataController element → outputs[].statePath declare /computed keys.
  if (path.startsWith("/elements/")) {
    const el = p.value as { type?: unknown; props?: { outputs?: unknown } } | null;
    if (el && el.type === "DataController" && Array.isArray(el.props?.outputs)) {
      for (const o of el.props!.outputs as Array<{ statePath?: unknown }>) {
        if (typeof o?.statePath === "string") addFromStatePath(o.statePath);
      }
    }
  }

  // /state seed carrying computed/datasets objects.
  if (path === "/state" && p.value && typeof p.value === "object") {
    for (const prefix of ["computed", "datasets"] as const) {
      const o = (p.value as Record<string, unknown>)[prefix];
      if (o && typeof o === "object") {
        for (const k of Object.keys(o as Record<string, unknown>)) valid[prefix].add(k);
      }
    }
  }

  // Direct /state/computed/<key> or /state/datasets/<key> add.
  const dm = /^\/state\/(computed|datasets)\/([^/]+)/.exec(path);
  if (dm) valid[dm[1] as "computed" | "datasets"].add(dm[2]);
}

/** Replace all `$result:<key>` and `$chartData:<key>` placeholders in a line. */
export function resolveSpecPlaceholders(
  line: string,
  results: Record<string, unknown>,
  chartData: Record<string, unknown>
): string {
  let processed = line;

  // ── Pass 0: object-form placeholders ───────────────────────────
  // LLMs sometimes emit {"$result": "key"} / {"$chartData": "key"} (the
  // json-render dynamic-value SHAPE with our placeholder NAME) instead of
  // the string form "$result:key". Untreated, a StatCard value renders
  // "[object Object]" and a chart gets a dict instead of rows. Normalize
  // them to the resolved value before the string passes run.
  const objectFormRegex = /\{\s*"\$(result|chartData)"\s*:\s*"([^"]+)"\s*\}/g;
  processed = processed.replace(objectFormRegex, (match, kind: string, keyPath: string) => {
    const key = keyPath.trim().replace(/^\$?(?:result|chartData):/, "");
    if (kind === "result") {
      const value = resolveKeyPath(results, key);
      if (value === undefined) return match;
      return JSON.stringify(unwrapScalar(value));
    }
    const direct = key in chartData ? chartData[key] : resolveKeyPath(chartData, key);
    if (direct !== undefined) return JSON.stringify(unwrapChartRows(direct));
    const repairKey = repairChartKey(key, Object.keys(chartData));
    if (repairKey) {
      logger.info("resolveSpecPlaceholders: repaired object-form chartData key", {
        from: key,
        to: repairKey,
      });
      return JSON.stringify(unwrapChartRows(chartData[repairKey]));
    }
    logger.warn("resolveSpecPlaceholders: unresolved object-form chartData, replacing with null", {
      keyPath: key,
      availableKeys: Object.keys(chartData),
    });
    void recordFailure({
      stage: "compose",
      kind: "compose",
      errorClass: "compose_key_unresolved",
      detail: key,
    });
    return "null";
  });

  // ── $chartData substitution ────────────────────────────────────
  // Pass 1: top-level + nested keys
  for (const [key, value] of Object.entries(chartData)) {
    const placeholder = `"$chartData:${key}"`;
    if (processed.includes(placeholder)) {
      processed = processed.replaceAll(placeholder, JSON.stringify(unwrapChartRows(value)));
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [subKey, subVal] of Object.entries(value as Record<string, unknown>)) {
        const subPlaceholder = `"$chartData:${key}.${subKey}"`;
        if (processed.includes(subPlaceholder)) {
          processed = processed.replaceAll(subPlaceholder, JSON.stringify(subVal));
        }
      }
    }
  }
  // Pass 2 fallback: composite assembly + fuzzy match for unresolved keys
  if (processed.includes("$chartData:")) {
    const fallbackRegex = /"\$chartData:([^"]+)"/g;
    processed = processed.replace(fallbackRegex, (_match, keyPath: string) => {
      if (keyPath === "globe" || keyPath === "globe_data") {
        const assembled: Record<string, unknown> = {};
        if ("points" in chartData) assembled.points = chartData.points;
        if ("arcs" in chartData) assembled.arcs = chartData.arcs;
        if (Object.keys(assembled).length > 0) return JSON.stringify(assembled);
      }
      const normalized = keyPath.toLowerCase().replace(/[-_]/g, "");
      for (const [k, v] of Object.entries(chartData)) {
        if (k.toLowerCase().replace(/[-_]/g, "") === normalized) {
          return JSON.stringify(v);
        }
      }
      const repairKey = repairChartKey(keyPath, Object.keys(chartData));
      if (repairKey) {
        logger.info("resolveSpecPlaceholders: repaired chartData key", {
          from: keyPath,
          to: repairKey,
        });
        return JSON.stringify(unwrapChartRows(chartData[repairKey]));
      }
      logger.warn(
        "resolveSpecPlaceholders: unresolved chartData placeholder, replacing with null",
        {
          keyPath,
          availableKeys: Object.keys(chartData),
        }
      );
      void recordFailure({
        stage: "compose",
        kind: "compose",
        errorClass: "compose_key_unresolved",
        detail: keyPath,
      });
      return "null";
    });
  }

  // ── $result substitution ──────────────────────────────────────
  // Pass 1: standalone JSON string values like "$result:total_sales" → raw JSON value
  const resultRegex = /"\$result:([^"]+)"/g;
  processed = processed.replace(resultRegex, (_match, keyPath: string) => {
    const value = resolveKeyPath(results, keyPath.trim());
    if (value === undefined) return _match;
    // If python emitted `{value: 506, format: "n0", label: "Total Deals"}`-style
    // wrappers, the StatCard's `value` prop would receive the whole object and
    // render "[object Object]". Unwrap a clear scalar payload before stringify.
    return JSON.stringify(unwrapScalar(value));
  });

  // Pass 2: inline placeholders within larger strings, e.g. "F-stat: $result:f_stat"
  // Lookahead `[^a-zA-Z0-9_.]|$` stops at any character that can't continue a
  // valid key — picks up `)`, `%`, `:`, etc. that the original `[",}\s]`
  // lookahead missed and left raw in narrative text. A `.` NOT followed by a
  // word character is sentence punctuation, not a key-path segment — without
  // that alternative, a sentence-final placeholder ("led by $result:top_region.")
  // never resolves.
  const inlineResultRegex =
    /\$result:([a-zA-Z0-9_]+(?:\.[\w][^\n",}]*?)*?)(?=\.(?![a-zA-Z0-9_])|[^a-zA-Z0-9_.]|$)/g;
  processed = processed.replace(inlineResultRegex, (_match, keyPath: string) => {
    const raw = resolveKeyPath(results, keyPath.trim());
    if (raw === undefined) return _match;
    const value = unwrapScalar(raw);
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : parseFloat(value.toFixed(4)).toString();
    }
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (value === null) return "null";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });

  return processed;
}

/**
 * If a Python sub-question emits `{value: 506, format: "n0"}` (or similar
 * wrapping conventions) instead of a bare scalar, unwrap to the inner scalar.
 * Otherwise return the value unchanged.
 *
 * We treat a value as "scalar-wrapped" when it is a plain object containing a
 * `value` key whose inner value is a primitive, and the other keys look like
 * presentation metadata (`format`, `label`, `unit`, `prefix`, `suffix`,
 * `is_integer`, `delta`, `previous`).
 */
export function unwrapScalar(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (!("value" in obj)) return value;
  const inner = obj.value;
  const isScalar =
    inner === null ||
    typeof inner === "string" ||
    typeof inner === "number" ||
    typeof inner === "boolean";
  if (!isScalar) return value;
  const allowed = new Set([
    "value",
    "format",
    "label",
    "unit",
    "prefix",
    "suffix",
    "is_integer",
    "delta",
    "previous",
    "trend",
    "icon",
    "color",
  ]);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return value;
  }
  return inner;
}

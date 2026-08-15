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
/**
 * Prefix-tolerant token subset match: every requested token appears in the
 * candidate (allowing prefix equality, "seg" ~ "segment"). Returns the
 * UNIQUE candidate or undefined — an ambiguous repair is worse than an
 * empty chart. Covers the observed composer drift family:
 * monthly_line→monthly_churn_line, seg_bar→segment_churn_bar,
 * dumbbell→segment_jan_vs_dec_dumbbell, waterfall→waterfall_decomposition.
 */
function uniqueTokenSubsetMatch(base: string, candidates: Set<string>): string | undefined {
  const tokens = (k: string) =>
    normalizeStateKey(k) === k
      ? k.split(/[^a-z0-9]+/).filter(Boolean)
      : k
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
  const want = base
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (want.length === 0) return undefined;
  const hits: string[] = [];
  for (const cand of candidates) {
    const have = tokens(cand);
    const covered = want.every((w) =>
      have.some((h) => h === w || h.startsWith(w) || w.startsWith(h))
    );
    if (covered) hits.push(cand);
  }
  return hits.length === 1 ? hits[0] : undefined;
}

function repairStatePath(path: string, valid: ValidStateKeys): string {
  const m = /^\/(computed|datasets)\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return path;
  const prefix = m[1] as "computed" | "datasets";
  const base = m[2];
  const rest = m[3] ?? "";
  const set = valid[prefix];
  if (set.has(base)) return path;
  const norm = normalizeStateKey(base);
  // 1. Normalized exact match, same prefix.
  for (const v of set) {
    if (normalizeStateKey(v) === norm) return `/${prefix}/${v}${rest}`;
  }
  // 2. Normalized exact match, OTHER prefix (composer bound /computed/x for
  //    data that lives under /datasets/x — the run-8 failure family, where
  //    every chart in a no-DataController spec pointed at computed keys
  //    nothing produced while the arrays sat in datasets).
  const other = prefix === "computed" ? "datasets" : "computed";
  for (const v of valid[other]) {
    if (normalizeStateKey(v) === norm) return `/${other}/${v}${rest}`;
  }
  // 3. Unique token-subset match — datasets first (arrays live there).
  const inDatasets = uniqueTokenSubsetMatch(base, valid.datasets);
  if (inDatasets) return `/datasets/${inDatasets}${rest}`;
  const inComputed = uniqueTokenSubsetMatch(base, valid.computed);
  if (inComputed) return `/computed/${inComputed}${rest}`;
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

// ── Inline-prose refusal + unit rendering ────────────────────────
// The composer is values-blind: it cannot know a key resolves to a flag or
// what unit a number carries. Two consequences, handled HERE (the only
// value-aware seam) rather than by prompt rules alone:
//  - a boolean/null/sentinel value must never render inside a sentence
//    ("rates are Yes", "the base size none the...") — refuse and strip,
//    the same posture as unresolved inline tokens;
//  - a finding's number renders WITH its declared unit ("0.9 pp"), so the
//    composer never writes unit words and can never re-unit a value.

const SENTINEL_INLINE = new Set(["none", "n/a", "na", "null", ""]);

function isInlineRefused(value: unknown): boolean {
  return (
    typeof value === "boolean" ||
    value === null ||
    (typeof value === "string" && SENTINEL_INLINE.has(value.trim().toLowerCase()))
  );
}

// Refusal marker: the containing SENTENCE is removed in a cleanup pass —
// stripping only the token leaves the sentence stranded ("described as: .").
const REFUSAL_MARKER = "\u0000";

function refuseInline(token: string): string {
  logger.warn("resolveSpecPlaceholders: refused sentinel/boolean inline in prose", { token });
  void recordFailure({
    stage: "compose",
    kind: "compose",
    errorClass: "compose_sentinel_inline",
    detail: token,
  });
  return REFUSAL_MARKER;
}

/**
 * Remove every sentence that contains a refusal marker, per JSON string
 * (never across quotes). Sentence boundary = [.!?] followed by whitespace —
 * decimals ("0.9 pp") have no space after the dot, so they don't split.
 * A string reduced to nothing renders as empty prose, which reads better
 * than a stranded "described as: .".
 */
function stripRefusedSentences(line: string): string {
  if (!line.includes(REFUSAL_MARKER)) return line;
  return line.replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner: string) => {
    if (!inner.includes(REFUSAL_MARKER)) return whole;
    const sentences = inner.split(/(?<=[.!?])\s+/);
    const kept: string[] = [];
    let dropped = false;
    for (const sentence of sentences) {
      if (sentence.includes(REFUSAL_MARKER)) {
        dropped = true;
        continue;
      }
      // Discourse anaphora: a sentence opening with This/That/It/These/Those
      // right after a dropped one refers to the dropped subject — keeping it
      // asserts a detection that didn't happen ("Largest jump: <stripped>.
      // This exceeded the baseline spread of N."), which reads as a finding.
      if (dropped && /^(?:This|That|It|These|Those)\b/.test(sentence.trim())) {
        continue;
      }
      dropped = false;
      kept.push(sentence);
    }
    return `"${kept.join(" ").trim()}"`;
  });
}

/** snake_case machine identifiers read as code in prose — humanize to words.
 *  ("churn_volume_effect" → "churn volume effect"). */
const IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function humanizeIfIdentifier(value: string): string {
  return IDENTIFIER_RE.test(value) ? value.replace(/_/g, " ") : value;
}

/** Currency units, mirroring the MONETARY allowlist in the sandbox runtime
 *  (docker/sandbox/hermetic_runtime/regimes.py `_CURRENCIES`). Keep the two in
 *  step: the runtime decides zero-sentinel policy from it, this decides display
 *  precision, and a unit in one set but not the other reads inconsistently. */
export const CURRENCY_UNITS = new Set([
  "usd",
  "eur",
  "gbp",
  "jpy",
  "dm",
  "dollar",
  "dollars",
  "$",
  "€",
  "£",
  "¥",
  "cents",
  "cad",
  "aud",
  "chf",
]);

export function isCurrencyUnit(unit: string | undefined): boolean {
  return !!unit && CURRENCY_UNITS.has(unit.trim().toLowerCase());
}

/** Fields that ARE the finding's measure, carried in the measure's own unit,
 *  and so inherit the finding's declared unit. Deliberately excludes anything
 *  unitless (n, skew, p_value, n_zero_excluded, *_share) and anything in a
 *  DERIVED unit (slope_per_period is unit-per-period, multiplier is a ratio). */
const MEASURE_UNIT_FIELDS = new Set([
  "value",
  "raw_value",
  "peak_value",
  "median",
  "mean",
  "average",
  "p25",
  "p75",
  "min",
  "max",
  "std",
  "mad",
  "iqr",
  "spread",
  "delta",
  "baseline_spread",
  "early_median",
  "late_median",
  // The current-state rider's raw trailing observation is the measure in
  // the measure's unit (run dfe3ea32 rendered it bare beside a unit-carrying
  // attested value in the same sentence).
  "latest_value",
]);

/** Money renders as money: 2 decimal places and thousands separators, always.
 *  A statement analysis shipped "1138.4 usd", "37.2759" and "16.635" into
 *  prose (run 77051c9d) — parseFloat().toString() drops the cent and the
 *  grouping, so totals read like float dumps rather than amounts. */
function formatCurrencyInline(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Inline numeric formatting. toFixed(4) rounds tiny magnitudes to 0 — a
 *  p-value of 9e-7 must never narrate as "p = 0". Pass `unit` so monetary
 *  bindings get money precision; without it a currency reads as a raw float. */
function formatInlineNumber(value: number, unit?: string): string {
  if (isCurrencyUnit(unit)) return formatCurrencyInline(value);
  if (Number.isInteger(value)) return String(value);
  if (value !== 0 && Math.abs(value) < 0.00005) return value.toExponential(2);
  return parseFloat(value.toFixed(4)).toString();
}

const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── The inline value renderer (specs/finding-field-roles-2026-08-13.md §2.M1) ──
//
// How a bound value is SAID in prose, dispatched on shape derived from the
// value itself. This replaced renderSmallDictInline and its 6-leaf cliff,
// which produced opposite disasters in two consecutive runs: 77051c9d swept
// an 11-entry group_ns to "" ("…spanning group sizes of " hung mid-clause);
// f47eb42d, after the cliff was routed into sentence-refusal, shipped an
// EMPTY ANSWER because the answer's one sentence bound an 11-entry share
// map. Both treated ordinary English — a share breakdown, a confidence
// interval — as unspeakable.

/** n ≤ this ⇒ a mapping names every entry (no residual clause). From n+1
 *  up: top MAPPING_TOP_N named, the minimum named, the middle summarised. */
const MAPPING_NAME_ALL_MAX = 4;
const MAPPING_TOP_N = 3;
/** Sequences longer than this are not prose ("a, b and c" has a limit). */
const SEQUENCE_MAX = 8;

const isScalar = (x: unknown): x is number | string =>
  typeof x === "number" || (typeof x === "string" && x.length > 0);

const fmtEntry = (val: number | string, unit?: string): string => {
  if (typeof val !== "number") return String(val);
  const num = formatInlineNumber(val, unit);
  if (!unit) return num;
  if (unit === "%" || unit === "pct") return `${num}%`;
  return `${num} ${unit}`;
};

/**
 * Render a bound non-scalar value as prose, or null when it is genuinely
 * unspeakable (nested, huge, mixed). Callers must never delete the
 * surrounding sentence on null — that is how an ANSWER vanished.
 *
 *  - interval (2-element numeric array): "-11.15 to 11.51"
 *  - sequence (≤8 scalars):              "a, b and c"
 *  - mapping (flat dict of scalars):     all entries when n ≤ 4; from n = 5,
 *      the top 3 by value, then "down to <min>", then a count of the middle —
 *      the minimum is named deliberately, so a group-sizes disclosure
 *      surfaces the thin group (n = 2) instead of hiding it in "8 others".
 */
export function renderInlineValue(value: unknown, unit?: string): string | null {
  if (Array.isArray(value)) {
    if (value.length === 2 && value.every((x) => typeof x === "number")) {
      const [lo, hi] = value as number[];
      const span = `${formatInlineNumber(lo, unit)} to ${formatInlineNumber(hi, unit)}`;
      return unit && unit !== "%" && unit !== "pct" ? `${span} ${unit}` : span;
    }
    if (value.length > 0 && value.length <= SEQUENCE_MAX && value.every(isScalar)) {
      const parts = value.map((x) => fmtEntry(x, unit));
      return parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return null;
    if (!entries.every(([, v]) => isScalar(v))) return null;
    const numeric = entries.every(([, v]) => typeof v === "number");
    if (!numeric) {
      // Mixed scalar dicts (strings among numbers) keep the plain k: v form,
      // small only — ranking strings makes no sense.
      if (entries.length > MAPPING_NAME_ALL_MAX + 2) return null;
      return entries
        .map(([k, v]) => `${humanizeIfIdentifier(k)}: ${fmtEntry(v as number | string, unit)}`)
        .join(", ");
    }
    const ranked = [...(entries as [string, number][])].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    const say = ([k, v]: [string, number]) => `${humanizeIfIdentifier(k)} at ${fmtEntry(v, unit)}`;
    if (ranked.length <= MAPPING_NAME_ALL_MAX) {
      const parts = ranked.map(say);
      return parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    }
    const top = ranked.slice(0, MAPPING_TOP_N).map(say);
    const min = ranked[ranked.length - 1];
    const between = ranked.length - MAPPING_TOP_N - 1;
    const betweenClause =
      between === 1 ? "with 1 more in between" : `with ${between} more in between`;
    return `${top.join(", ")}, down to ${say(min)} (${betweenClause})`;
  }
  return null;
}

const METRIC_FAMILIES = [
  "median",
  "mean",
  "average",
  "iqr",
  "p25",
  "p75",
  "max",
  "min",
  "spread",
  "std",
];
const metricCanon = (w: string): string => (w === "average" ? "mean" : w);

/**
 * Repair a binding to the metric the PROSE names (run-41 root fix): the
 * composer bound $result:iqr_price_slope_per_period inside "The median
 * price series is rising (OLS slope ...)". The substitution machinery was
 * fine — the KEY choice was wrong, and the sentence itself declares the
 * intent. Conservative repair, all four required:
 *   1. the sentence names exactly ONE metric family word;
 *   2. a bound key belongs to a DIFFERENT family;
 *   3. swapping that family for the named one yields an EXISTING key;
 *   4. no other binding in the sentence contradicts the named family.
 * Runs pre-substitution; the mislabel lint remains the backstop for cases
 * this cannot repair unambiguously.
 */
export function repairMetricBindings(line: string, results: Record<string, unknown>): string {
  if (!line.includes("$result:")) return line;
  return line.replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner: string) => {
    if (!/[a-zA-Z]{3}/.test(inner) || !inner.includes("$result:")) return whole;
    const sentences = inner.split(/(?<=[.!?])\s+/);
    let changed = false;
    const repaired = sentences.map((sentence) => {
      const proseFams = new Set(
        [...sentence.matchAll(new RegExp(`\\b(${METRIC_FAMILIES.join("|")})\\b`, "gi"))]
          .map((m) => metricCanon(m[1].toLowerCase()))
          // Only words OUTSIDE binding tokens count as prose intent.
          .filter((_w, i, _a) => true)
      );
      // Remove families that only appear inside $result tokens.
      const tokenText = [...sentence.matchAll(/\$result:[a-zA-Z0-9_.]+/g)]
        .map((m) => m[0])
        .join(" ");
      for (const fam of [...proseFams]) {
        const inProse = new RegExp(`\\b${fam}\\b`, "i").test(
          sentence.replace(/\$result:[a-zA-Z0-9_.]+/g, "")
        );
        if (!inProse) proseFams.delete(fam);
      }
      if (proseFams.size !== 1) return sentence;
      const named = [...proseFams][0];
      return sentence.replace(/\$result:([a-zA-Z0-9_.]+)/g, (tok, key: string) => {
        const fam = METRIC_FAMILIES.map(metricCanon).find((f) => f !== named && key.includes(f));
        if (!fam) return tok;
        const sibling = key.replace(fam, named);
        if (sibling === key || !(sibling in results)) return tok;
        changed = true;
        logger.info("resolveSpecPlaceholders: repaired binding to the prose-named metric", {
          from: key,
          to: sibling,
        });
        return `$result:${sibling}`;
      });
    });
    return changed ? `"${repaired.join(" ")}"` : whole;
  });
}

/** Unit encoded in a key/field NAME: "_pct" suffix or "pct_" prefix → "%",
 *  "_pp" suffix → "pp". Applied to the LAST path segment. */
function keyNameUnit(keyPath: string): string | undefined {
  const seg = keyPath.split(".").pop() ?? keyPath;
  if (/_pct$/.test(seg) || /^pct_/.test(seg)) return "%";
  if (/_pp$/.test(seg)) return "pp";
  return undefined;
}

/** "0.9" + "pp" → "0.9 pp"; "%" attaches without a space. Skips appending
 *  when the unit word already appears within the next few words of prose —
 *  not just immediately ("$finding:x cases total cases" came from a guard
 *  that only looked one word ahead while the composer wrote "total cases"). */
function withUnit(num: string, unit: string, following: string): string {
  const ahead = following
    .slice(0, 64)
    .split(/[^\p{L}\p{N}%]+/u)
    .slice(0, 4);
  if (ahead.some((w) => w.toLowerCase() === unit.toLowerCase())) return num;
  if (unit === "%" && /^\s*%/.test(following)) return num;
  return unit === "%" ? `${num}%` : `${num} ${unit}`;
}

/** Replace all `$result:<key>` and `$chartData:<key>` placeholders in a line. */
export function resolveSpecPlaceholders(
  line: string,
  results: Record<string, unknown>,
  chartData: Record<string, unknown>,
  /** Declared-findings values by (possibly step-qualified) name — enables
   *  `$finding:<name>[.<field>]` binding (declared-findings spec §4.2). */
  findings: Record<string, unknown> = {},
  /** Declared units by finding name — inline numeric bindings render with
   *  the unit attached, so the composer never writes unit words. */
  findingUnits: Record<string, string> = {},
  /** Declared units by RESULT key (analysis-product spec: declare_value
   *  units + finding-mirror units) — consulted ahead of key-name morphology
   *  so unit identity comes from the declaration, not the _pct suffix. */
  declaredUnits: Record<string, string> = {}
): string {
  // ── $series alias (analysis-product spec §2) ───────────────────
  // A declared series' rows ARE chart_data[id] (synthesized, single writer),
  // so the typed alias resolves through the same table — accepted in string
  // and object form so a composer that picked up the catalog's series
  // framing never strands a token.
  let processed = line
    .replace(/\$series:/g, "$chartData:")
    .replace(/\{\s*"\$series"\s*:/g, '{"$chartData":');
  processed = repairMetricBindings(processed, results);

  // ── $finding substitution (declared-findings spec §4.2) ─────────
  // Same three shapes the $result: history proved LLMs emit: object-form,
  // standalone value-form, and inline-in-prose. Runs FIRST so a finding
  // named like a result key resolves as the finding the composer bound.
  if (Object.keys(findings).length > 0) {
    // Object-form: {"$finding": "name"} → resolved value.
    processed = processed.replace(
      /\{\s*"\$finding"\s*:\s*"([^"]+)"\s*\}/g,
      (match, keyPath: string) => {
        const value = resolveKeyPath(findings, keyPath.trim().replace(/^\$?finding:/, ""));
        return value === undefined ? match : JSON.stringify(unwrapScalar(value));
      }
    );
    // Value-form: "prop": "$finding:name" or "$finding:name.field".
    processed = processed.replace(/"\$finding:([^"]+)"/g, (_match, keyPath: string) => {
      const value = resolveKeyPath(findings, keyPath.trim());
      if (value === undefined) return _match;
      return JSON.stringify(unwrapScalar(value));
    });
    // Inline-form: mid-sentence. Structured values need a `.field` path —
    // a bare "shares" finding must not print a JSON object into prose, so
    // objects resolve only when the path reached a leaf.
    const inlineFindingRegex =
      /\$finding:([a-zA-Z0-9_]+(?:\.[\w][^\n",}]*?)*?)(?=\.(?![a-zA-Z0-9_])|[^a-zA-Z0-9_.]|$)/g;
    processed = processed.replace(
      inlineFindingRegex,
      (_match, keyPath: string, offset: number, whole: string) => {
        const trimmed = keyPath.trim();
        const raw = resolveKeyPath(findings, trimmed);
        if (raw === undefined) return _match;
        const value = unwrapScalar(raw);
        if (isInlineRefused(value)) return refuseInline(_match);
        // Unit applies to the finding's MAIN value: a bare scalar binding,
        // its conventional `.value` field, or a field that IS the measure in
        // the measure's own unit (MEASURE_UNIT_FIELDS) — never arbitrary
        // fields (a decomposition's p_value is not in pp; skew, n and
        // n_zero_excluded are unitless). Fields carry units in their NAME
        // (pct_from_peak, delta_pp) — honor the same suffix/prefix
        // convention as $result keys so "-61.44 from peak" renders
        // "-61.44%". Resolved ahead of BOTH branches: scalars need it for
        // money precision, and the value renderer needs it for interval and
        // mapping entries.
        const field = trimmed.includes(".") ? trimmed.slice(trimmed.lastIndexOf(".") + 1) : "";
        const parent = trimmed.includes(".") ? trimmed.slice(0, trimmed.lastIndexOf(".")) : "";
        const unit =
          findingUnits[trimmed] ??
          findingUnits[trimmed.replace(/\.value$/, "")] ??
          (MEASURE_UNIT_FIELDS.has(field) ? findingUnits[parent] : undefined) ??
          keyNameUnit(trimmed);
        if (typeof value === "number") {
          // Resolve the unit BEFORE formatting: money needs 2dp and grouping,
          // which the generic float path strips.
          const num = formatInlineNumber(value, unit);
          return unit ? withUnit(num, unit, whole.slice(offset + _match.length)) : num;
        }
        if (typeof value === "object") {
          // The value renderer (spec §2.M1): intervals, sequences and
          // mappings are ordinary English. Genuinely unspeakable values
          // (nested, huge, mixed) fall through to the sweep, which strips
          // the TOKEN but never the sentence — run 77051c9d (dangling
          // clause) and run f47eb42d (EMPTY ANSWER) are the two proofs that
          // neither harsher posture survives contact with real documents.
          const prose = renderInlineValue(value, unit);
          return prose ?? _match;
        }
        return humanizeIfIdentifier(String(value));
      }
    );
  }

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
  processed = processed.replace(
    inlineResultRegex,
    (_match, keyPath: string, offset: number, whole: string) => {
      const trimmed = keyPath.trim();
      const raw = resolveKeyPath(results, trimmed);
      if (raw === undefined) return _match;
      const value = unwrapScalar(raw);
      if (isInlineRefused(value)) return refuseInline(_match);
      if (typeof value === "number") {
        const num = formatInlineNumber(value);
        // Unit identity: a DECLARED unit (declare_value / finding mirror)
        // wins; the _pct/_pp/pct_ name convention remains the fallback for
        // keys nothing declared.
        const unit = declaredUnits[trimmed] ?? keyNameUnit(trimmed);
        if (!unit) return num;
        return withUnit(num, unit, whole.slice(offset + _match.length));
      }
      if (typeof value === "object") return JSON.stringify(value);
      return humanizeIfIdentifier(String(value));
    }
  );

  // ── Final sweep: any "$result:"/"$chartData:" that survived every pass is
  // genuinely unresolvable (the composer named a key that was never computed,
  // e.g. "$result:step_1_title" for a title that isn't a result scalar). NEVER
  // leak the raw token to the UI: blank the JSON-value form (→ null) and strip
  // the inline-prose form. Log AND record each miss — a warn line for live
  // visibility (mirrors the $chartData path) plus the failure log for per-run
  // diagnostics; a recurring key here means composer prompt drift to chase.
  const recordMiss = (token: string, form: "value" | "inline") => {
    logger.warn("resolveSpecPlaceholders: unresolved placeholder swept", { token, form });
    void recordFailure({
      stage: "compose",
      kind: "compose",
      // Findings get their own class (spec §4.2): a recurring miss here means
      // the composer bound a name the manifest never carried.
      errorClass: token.includes("$finding:")
        ? "compose_finding_unresolved"
        : "compose_key_unresolved",
      detail: token,
    });
  };
  processed = processed.replace(/"\$(?:result|chartData|finding):[^"\n]+"/g, (m) => {
    recordMiss(m, "value");
    return "null";
  });
  if (/\$(?:result|chartData|finding):/.test(processed)) {
    // Consume the WHOLE malformed key, including punctuation a bad key may embed
    // from a data value (".", ",", "-" — e.g. "$result:..._on-demand_pct"). The
    // earlier passes only match `[a-zA-Z0-9_.]`, so a hyphen would truncate the
    // token and this sweep would strip just the head, leaving an orphaned tail
    // ("-demand_pct") in the prose. Match the full key-ish run so nothing leaks.
    // (Only unresolved survivors reach here — resolved placeholders were already
    // replaced — so aggressive consumption is safe.)
    processed = processed.replace(/\$(?:result|chartData|finding):[a-zA-Z0-9_.,-]+/g, (m) => {
      recordMiss(m, "inline");
      return "";
    });
    // A stripped token can leave its introducing function word hanging at a
    // sentence boundary — "sorted into location types via " shipped in run
    // 9c415dc8 (the planner bound a 62-leaf dict, the renderer refused it,
    // the sweep took the token). Trim orphaned function words back to a
    // clean clause end. Runs ONLY when this call actually stripped a token,
    // so ordinary prose is never touched (and a sentence ending in a bare
    // preposition is ungrammatical regardless).
    processed = trimDanglingFunctionWords(processed);
  }

  return stripRefusedSentences(processed);
}

/** Function words that cannot legally end a sentence — the residue an
 *  inline token strip leaves behind ("…location types via ", "…drawn
 *  from ."). Trimmed iteratively so "sorted into via " collapses fully;
 *  a leading comma before the orphan goes with it. Exported for tests. */
const DANGLING_FUNCTION_WORD =
  /(?:,\s*)?\b(?:via|of|into|onto|from|by|with|within|under|over|per|at|in|to|as|for|and|or|the|a|an)\s*(?=[.;:!?]\s|[.;:!?]?\s*(?:\\"|"|$))/;

export function trimDanglingFunctionWords(text: string): string {
  let out = text;
  const re = new RegExp(DANGLING_FUNCTION_WORD.source, "g");
  for (let i = 0; i < 5; i++) {
    const next = out.replace(re, "");
    if (next === out) break;
    out = next;
  }
  // Collapse the doubled spaces trimming can leave ("types  .") and any
  // space stranded before end punctuation.
  return out === text ? text : out.replace(/ {2,}/g, " ").replace(/ +([.;:!?,])/g, "$1");
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

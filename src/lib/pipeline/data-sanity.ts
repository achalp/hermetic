/**
 * Checks on the SHAPE of the data behind a narrative, rather than on the prose.
 *
 * The existing grounding checks ask whether the story's numbers were computed
 * and whether its direction matches a computed verdict. These ask a different
 * question: is the data itself telling us something the write-up should have
 * disclosed? Three patterns, all observed in one exported correlation dashboard
 * for King County, and all general:
 *
 *  1. A single-period OUTLIER that dominates a trend statistic. Homelessness
 *     dropped ~60% in 2021 and rebounded — almost certainly a disrupted
 *     point-in-time count. Nothing mentioned it, yet it is what inflated the
 *     p-value behind "trended flat".
 *
 *  2. A trend called FLAT whose endpoints moved a lot. The series ran ~470 to
 *     ~730 (+55%) while the narrative said "trended flat (slope 10.8, p =
 *     0.0935)". Statistically defensible, and still wrong beside the chart. The
 *     check does not parse adjectives — it detects the CONDITION (a
 *     non-significant slope alongside a large endpoint move) and says so.
 *
 *  3. A correlation of ±1.000 between two DIFFERENT variables, which is a
 *     definitional identity rather than a finding. The matrix carried
 *     Availability (D1) <-> Vacancy Rate = -1.00 because the availability
 *     sub-index IS the vacancy rate, so the same variable appeared twice.
 *
 * Everything here is advisory: it adds caveats, never edits a number.
 */

/**
 * PROVISIONAL — see specs/dashboard-integrity-thresholds-2026-09-12.md. Derived
 * from one dashboard; only P_SIGNIFICANT and IDENTITY_R have justification from
 * outside that run.
 */

/** Significance threshold for calling a slope "not significant". */
const P_SIGNIFICANT = 0.05;
/** Endpoint move (fraction of the series' typical level) that contradicts "flat". */
const FLAT_CONTRADICTION_MOVE = 0.2;
/** Deviation from the local level that marks a point as a spike or dropout —
 *  a FLOOR, not the test. See SPIKE_VOLATILITY_MULTIPLE. */
const SPIKE_DEVIATION = 0.4;

/**
 * How many times a series' OWN typical movement a point must deviate before it
 * counts as anomalous.
 *
 * A fixed percentage cannot work across series: the first version used 40% flat
 * and fired on `expansion_mrr_delta` in the golden ask-followup journey (41%
 * below its neighbours at 2024-07). A monthly MRR *delta* swings like that
 * routinely — that is what a delta is — while the King County homelessness
 * series moves ~5-10% a year, so its 55% collapse is six to ten times anything
 * it normally does. Same absolute deviation, opposite meanings.
 *
 * So the question is not "did it move a lot" but "did it move a lot FOR THIS
 * SERIES". Both conditions must hold: past the floor above, and past this
 * multiple of the series' habitual step.
 */
const SPIKE_VOLATILITY_MULTIPLE = 3;

/**
 * How far PAST the bar the evidence must be before the caveat is worth saying.
 *
 * Not tuning-by-another-name: the principle is that an advisory which fires on
 * marginal evidence is noise the reader has to adjudicate, and a caveat that
 * appears on most dashboards stops being read at all — the same reason the
 * boot-health warning was made runtime-aware rather than left crying wolf.
 *
 * The evidence for needing it is a firing RATE, not a preference. The golden
 * suite's `expansion_mrr_delta` (2800, 2100, 2400, 2100, 1800, 1100, 1900, 1600,
 * 1800, 1600, 1800) clears the volatility bar by 0.8% — 0.405 against 0.402 —
 * which is a coin flip, and it was one of three golden journeys. King County's
 * 2021 collapse clears the same bar by 3.4x. A rule that separates those two
 * only by a hair is not discriminating between them; one that demands clear air
 * is.
 */
const SPIKE_CONFIDENCE_MARGIN = 1.5;
/** How closely the neighbours must agree for the middle point to be judged a
 *  spike rather than a step change in level. */
const NEIGHBOUR_AGREEMENT = 0.3;
/** |r| at or above which two distinct variables are the same variable. */
const IDENTITY_R = 0.999;

export interface SeriesAnomaly {
  series: string;
  /** x value of the anomalous point, when the rows carry one. */
  at?: string;
  /** How far the point sits from the series' median, as a fraction of it. */
  deviation: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Points that break the LOCAL pattern — a spike or dropout, not a trend.
 *
 * Deliberately not "far from the series median": in a rising series every recent
 * point is far from the median, and the first draft duly flagged 2024 (the
 * endpoint of the rise, +42%) alongside 2021 (the ~60% collapse). Only one of
 * those is a data problem.
 *
 * So each point is judged against its immediate NEIGHBOURS. A glitch sits far
 * from both; a trending point sits close to the one before it. Endpoints are
 * skipped because a boundary value has no second side to be judged against —
 * there is no way to tell a final spike from a continuing climb.
 *
 * A genuine STEP change is also excluded: when the neighbours disagree with each
 * other, the level shifted rather than one reading being wrong.
 */
export function findSeriesOutliers(
  rows: Record<string, unknown>[],
  seriesKey: string,
  xKey?: string
): SeriesAnomaly[] {
  const points = rows
    .map((r) => ({ v: r?.[seriesKey], at: xKey ? r?.[xKey] : undefined }))
    .filter(
      (p): p is { v: number; at: unknown } => typeof p.v === "number" && Number.isFinite(p.v)
    );
  if (points.length < 5) return []; // too short for "the local pattern" to exist

  // The series' habitual step: the median relative change between consecutive
  // points. A volatile series earns a high bar; a smooth one a low bar.
  //
  // TRIMMED, because a spike contributes two enormous steps (in and out) and
  // would otherwise raise the bar past itself — the same self-hiding the median
  // absolute deviation avoids above. Dropping the two largest steps removes
  // exactly one spike's contribution however short the series is; on a long
  // series it changes the median barely at all.
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.v;
    if (prev === 0) continue;
    steps.push(Math.abs((points[i]!.v - prev) / prev));
  }
  const trimmed = [...steps].sort((a, b) => a - b).slice(0, Math.max(1, steps.length - 2));
  const typicalStep = median(trimmed);

  const out: SeriesAnomaly[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!.v;
    const next = points[i + 1]!.v;
    const local = (prev + next) / 2;
    if (local === 0) continue;
    // Neighbours must agree with each other, or this is a step, not a spike.
    const neighbourGap = Math.abs(prev - next) / Math.max(Math.abs(local), Number.EPSILON);
    if (neighbourGap > NEIGHBOUR_AGREEMENT) continue;
    const deviation = (points[i]!.v - local) / Math.abs(local);
    if (Math.abs(deviation) < SPIKE_DEVIATION) continue;
    // ...and it must be unusual FOR THIS SERIES, not merely large.
    if (
      typicalStep > 0 &&
      Math.abs(deviation) < typicalStep * SPIKE_VOLATILITY_MULTIPLE * SPIKE_CONFIDENCE_MARGIN
    ) {
      continue;
    }
    const at = points[i]!.at;
    out.push({
      series: seriesKey,
      ...(typeof at === "string" || typeof at === "number" ? { at: String(at) } : {}),
      deviation,
    });
  }
  return out;
}

/**
 * A slope reported as non-significant while the series' endpoints moved a lot.
 * Both statements are true; presenting only the first reads as "nothing
 * happened" next to a chart that plainly shows otherwise.
 */
export function findFlatContradiction(
  rows: Record<string, unknown>[],
  seriesKey: string,
  slopeP: number
): { move: number } | null {
  if (!(slopeP > P_SIGNIFICANT)) return null;
  const values = rows
    .map((r) => r?.[seriesKey])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length < 3) return null;
  const level = Math.abs(median(values));
  if (level === 0) return null;
  const move = (values[values.length - 1]! - values[0]!) / level;
  return Math.abs(move) >= FLAT_CONTRADICTION_MOVE ? { move } : null;
}

export interface IdentityPair {
  a: string;
  b: string;
  r: number;
}

/**
 * Result keys of the form `corr_<a>_vs_<b>_pearson_r` whose |r| is ~1: the two
 * variables are the same measurement under two names, and reporting their
 * correlation as a finding double-counts it.
 */
export function findIdentityCorrelations(results: Record<string, unknown>): IdentityPair[] {
  const out: IdentityPair[] = [];
  for (const [key, value] of Object.entries(results ?? {})) {
    const m = /^corr_(.+)_vs_(.+)_pearson_r$/.exec(key);
    if (!m || typeof value !== "number" || !Number.isFinite(value)) continue;
    const [, a, b] = m as unknown as [string, string, string];
    if (a === b) continue;
    if (Math.abs(value) >= IDENTITY_R) out.push({ a, b, r: value });
  }
  return out;
}

/**
 * Two variables that are the same measurement must correlate IDENTICALLY (up to
 * sign) with any third. When they do not, the pairs were computed over different
 * rows — inconsistent null handling — and the numbers in the write-up disagree
 * with each other by a hair.
 *
 * Observed: vacancy<->homelessness r = 0.2637 while availability<->homelessness
 * r = -0.2639, with availability defined as -1x vacancy.
 */
export function findInconsistentMagnitudes(
  results: Record<string, unknown>,
  identities: IdentityPair[]
): { a: string; b: string; via: string; rA: number; rB: number }[] {
  const out: { a: string; b: string; via: string; rA: number; rB: number }[] = [];
  const rFor = (x: string, y: string): number | undefined => {
    const direct = results[`corr_${x}_vs_${y}_pearson_r`];
    if (typeof direct === "number") return direct;
    const flipped = results[`corr_${y}_vs_${x}_pearson_r`];
    return typeof flipped === "number" ? flipped : undefined;
  };
  const partners = new Set<string>();
  for (const key of Object.keys(results ?? {})) {
    const m = /^corr_(.+)_vs_(.+)_pearson_r$/.exec(key);
    if (m) {
      partners.add(m[1]!);
      partners.add(m[2]!);
    }
  }
  for (const id of identities) {
    for (const via of partners) {
      if (via === id.a || via === id.b) continue;
      const rA = rFor(id.a, via);
      const rB = rFor(id.b, via);
      if (rA === undefined || rB === undefined) continue;
      // Same magnitude expected; tolerate float noise only.
      if (Math.abs(Math.abs(rA) - Math.abs(rB)) > 1e-6) {
        out.push({ a: id.a, b: id.b, via, rA, rB });
      }
    }
  }
  return out;
}

export interface DataSanityInput {
  results?: Record<string, unknown>;
  /** chart_data: series id -> rows. */
  chartData?: Record<string, unknown>;
}

/** Advisory caveat lines, phrased for the reader of the summary. */
export function buildDataSanityCaveats(input: DataSanityInput): string[] {
  const caveats: string[] = [];
  const results = input.results ?? {};

  const identities = findIdentityCorrelations(results);
  for (const id of identities) {
    caveats.push(
      `${id.a.replace(/_/g, " ")} and ${id.b.replace(/_/g, " ")} correlate at ` +
        `${id.r.toFixed(2)} — they are the same measurement under two names, so treating ` +
        `them as separate findings counts it twice`
    );
  }
  for (const bad of findInconsistentMagnitudes(results, identities)) {
    caveats.push(
      `${bad.a.replace(/_/g, " ")} and ${bad.b.replace(/_/g, " ")} are the same measurement, ` +
        `but their correlations with ${bad.via.replace(/_/g, " ")} differ ` +
        `(${bad.rA.toFixed(4)} vs ${bad.rB.toFixed(4)}) — those pairs were computed over ` +
        `different rows`
    );
  }

  for (const [seriesId, raw] of Object.entries(input.chartData ?? {})) {
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const rows = raw as Record<string, unknown>[];
    const first = rows[0];
    if (!first || typeof first !== "object") continue;
    const numericKeys = Object.keys(first).filter((k) => typeof first[k] === "number");
    const xKey = Object.keys(first).find((k) => typeof first[k] === "string");
    for (const key of numericKeys) {
      for (const anomaly of findSeriesOutliers(rows, key, xKey)) {
        const pct = Math.round(Math.abs(anomaly.deviation) * 100);
        caveats.push(
          `${key.replace(/_/g, " ")} in ${seriesId.replace(/_/g, " ")} has an unusual value` +
            `${anomaly.at ? ` at ${anomaly.at}` : ""} — ${pct}% ` +
            `${anomaly.deviation < 0 ? "below" : "above"} the rest of the series; any trend ` +
            `figure over this window is sensitive to it`
        );
      }
      const slopeP = results[`${key}_slope_p`] ?? results[`${key}_trend_p`];
      if (typeof slopeP === "number") {
        const flat = findFlatContradiction(rows, key, slopeP);
        if (flat) {
          caveats.push(
            `${key.replace(/_/g, " ")} shows no statistically significant trend ` +
              `(p = ${slopeP.toFixed(3)}) even though it moved ` +
              `${Math.round(flat.move * 100)}% end to end — describing it as flat would ` +
              `understate what the chart shows`
          );
        }
      }
    }
  }
  return caveats;
}

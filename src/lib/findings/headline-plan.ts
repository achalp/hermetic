/**
 * Deterministic headline scaffold (structural fix 2, 2026-08-07).
 *
 * Headline tile selection used to be a freeform composer choice steered by
 * accumulating prose rules — and degraded monotonically (6 → 4 → 3 → 1
 * tiles) while the manifests stayed rich, plausibly BECAUSE the rule pile
 * diluted attention. The server now derives the required headline set from
 * the validated manifest + results by structural shape; the composer
 * arranges and labels but may not drop tiles. Pure function, no I/O.
 */
import type { FindingEntry } from "@/lib/contracts/findings";

export interface HeadlineTile {
  /** Placeholder the tile's value MUST bind ("$finding:x.value", "$result:k"). */
  binding: string;
  /** Suggested label — the composer may reword, not repurpose. */
  label: string;
  /** Optional binding for the tile description (e.g. the peak's period). */
  descriptionBinding?: string;
  /** Why this tile is required (shown to the composer, not the user). */
  reason: string;
}

const MAX_TILES = 5;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function humanize(name: string): string {
  return name
    .replace(/^step_\d+\./, "")
    .split(/[._]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function periodField(value: Record<string, unknown>): string | undefined {
  for (const k of ["period", "date", "month", "quarter", "year"]) {
    if (k in value) return k;
  }
  return undefined;
}

/**
 * Derive the required headline tiles: level/total, change metric, current
 * state, peak, question-primary — whichever the manifest/results actually
 * carry, capped at MAX_TILES in that priority order. Dedupes by binding.
 */
export function planHeadlineTiles(
  findings: FindingEntry[],
  results: Record<string, unknown>,
  question = ""
): HeadlineTile[] {
  const fieldValue = (f: FindingEntry, field: string): unknown =>
    isObj(f.value) ? (f.value as Record<string, unknown>)[field] : f.value;
  const usable = (f: FindingEntry, field: string): boolean => {
    const v = fieldValue(f, field);
    if (v === null || v === undefined) return false;
    const p = isObj(f.value) ? (f.value as Record<string, unknown>).p_value : undefined;
    // A slope with p ~ 1 is noise — a null upstream must never render as a
    // confident 0 tile ("Median Price Trend (per yr): 0").
    if (typeof p === "number" && p > 0.05 && /slope/.test(field)) return false;
    // Tautological delta: a distance-from-peak of exactly 0 means the
    // current period IS the peak — "Current vs Peak: 0" informs nothing.
    if (/pct_from_peak|_delta$|_change$/.test(field) && v === 0) return false;
    return true;
  };
  const tiles: HeadlineTile[] = [];
  const add = (t: HeadlineTile) => {
    if (tiles.length < MAX_TILES && !tiles.some((x) => x.binding === t.binding)) tiles.push(t);
  };

  // Question-primary finding first — the metric the question literally asks for.
  const q = question.toLowerCase();
  const primary =
    findings.find((f) => f.tags?.includes("question-primary")) ??
    findings.find((f) => {
      const toks = f.name.split(/[._]/).filter((t) => t.length > 2);
      return toks.length > 0 && toks.every((t) => q.includes(t));
    });
  if (primary) {
    const field = isObj(primary.value) && "value" in primary.value ? ".value" : "";
    add({
      binding: `$finding:${primary.name}${field}`,
      label: humanize(primary.name),
      reason: "question-primary",
    });
  }

  // Level/total: a scalar result whose key names a total.
  const totalKey = Object.keys(results).find(
    (k) => /(^|_)total(_|$)/.test(k) && typeof results[k] === "number"
  );
  if (totalKey) {
    add({ binding: `$result:${totalKey}`, label: humanize(totalKey), reason: "level" });
  }

  // Change metric: yoy pct_change, else a trend slope.
  const yoy = findings.find((f) => isObj(f.value) && "pct_change" in f.value);
  if (yoy && usable(yoy, "pct_change")) {
    add({
      binding: `$finding:${yoy.name}.pct_change`,
      label: humanize(yoy.name),
      reason: "change-metric",
    });
  } else {
    const trend = findings.find(
      (f) => isObj(f.value) && ("slope_per_period" in f.value || "slope" in f.value)
    );
    if (
      trend &&
      usable(
        trend,
        "slope_per_period" in (trend.value as Record<string, unknown>)
          ? "slope_per_period"
          : "slope"
      )
    ) {
      const field =
        "slope_per_period" in (trend.value as Record<string, unknown>)
          ? "slope_per_period"
          : "slope";
      add({
        binding: `$finding:${trend.name}.${field}`,
        label: humanize(trend.name),
        reason: "change-metric",
      });
    }
  }

  // Current state: the ending-state finding.
  const current = findings.find((f) => isObj(f.value) && "pct_from_peak" in f.value);
  if (current && usable(current, "pct_from_peak")) {
    const pf = periodField(current.value as Record<string, unknown>);
    add({
      binding: `$finding:${current.name}.pct_from_peak`,
      label: "Vs Peak",
      ...(pf ? { descriptionBinding: `$finding:${current.name}.${pf}` } : {}),
      reason: "current-state",
    });
  }

  // Peak: a {period-ish, value} superlative-shaped finding.
  const peak = findings.find((f) => {
    if (!isObj(f.value) || !("value" in f.value)) return false;
    return (
      periodField(f.value as Record<string, unknown>) !== undefined && /peak|max|top/.test(f.name)
    );
  });
  if (peak && usable(peak, "value")) {
    const pf = periodField(peak.value as Record<string, unknown>)!;
    add({
      binding: `$finding:${peak.name}.value`,
      label: humanize(peak.name),
      descriptionBinding: `$finding:${peak.name}.${pf}`,
      reason: "peak",
    });
  }

  return tiles;
}

/** Prompt block: the required-tiles contract handed to the composer. */
export function buildHeadlineSection(tiles: HeadlineTile[]): string {
  if (tiles.length === 0) return "";
  const lines = tiles.map(
    (t) =>
      `- value: "${t.binding}" — label like "${t.label}"${t.descriptionBinding ? ` — description binds "${t.descriptionBinding}"` : ""} (${t.reason})`
  );
  return `

## Required Headline Tiles (server-derived — include EVERY one)
The headline StatCard row is planned from the analysis' own findings. Create a StatCard for EACH binding below — relabel freely, order freely, but never drop one or substitute a different binding:
${lines.join("\n")}`;
}

/** Deterministic normalization of a results-level headline_stats array:
 *  duplicates (same label+value) dropped, capped at MAX_TILES + 1 — nine
 *  tiles with a doubled entry recurred across runs; presentation metadata
 *  is normalized at consumption, never trusted to generation. */
export function normalizeHeadlineStats(results: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const raw = results.headline_stats;
  if (!Array.isArray(raw)) return issues;
  const seen = new Set<string>();
  const deduped = raw.filter((entry) => {
    const e = entry as { label?: unknown; value?: unknown } | null;
    const sig = JSON.stringify([e?.label, e?.value]);
    if (seen.has(sig)) {
      issues.push(`duplicate headline stat dropped: ${sig}`);
      return false;
    }
    seen.add(sig);
    return true;
  });
  const cap = MAX_TILES + 1;
  if (deduped.length > cap) {
    issues.push(`headline_stats capped at ${cap} (was ${deduped.length})`);
  }
  results.headline_stats = deduped.slice(0, cap);
  return issues;
}

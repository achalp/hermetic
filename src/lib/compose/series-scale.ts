/**
 * Series plotted on one axis must be COMPARABLE on one axis.
 *
 * A single-axis chart renders every series against a shared range, so a series
 * two orders of magnitude smaller than its neighbour becomes a flat line pinned
 * to the floor — present in the legend, and conveying nothing.
 *
 * Observed in the King County correlation dashboard: "HDI Composite Distress,
 * Rental Vacancy Rate & Homelessness Rate Over Time" put homelessness (~230–730),
 * the composite score (~66–76) and vacancy rate (~3–5.5) on one 0–800 axis. Two
 * of the three series were straight lines along the bottom. The catalog already
 * ships DualAxisChart for exactly this — "for series on different scales/units" —
 * and the composer simply did not reach for it.
 *
 * So this is a lint over the DATA rather than guidance in a prompt: the chart's
 * own rows say whether its series share a scale, and that question has a
 * numeric answer. Charts whose series do share a scale are left alone.
 *
 * The rewrite also fixes an adjacent gap: LineChart and AreaChart have no axis
 * labels at all (only `label_map` for the legend), while DualAxisChart carries
 * left_label/right_label/x_label. Splitting the axes is what makes labelling them
 * meaningful — one measure per axis instead of three sharing a nameless one.
 */

/** Magnitude gap beyond which a shared axis flattens the smaller series.
 *  10x is where the smaller series' variation stops being legible; the observed
 *  case was ~100x (vacancy 3-5.5 against homelessness 230-730). */
const SCALE_RATIO_LIMIT = 10;

/** How tight a group must be to SHARE one axis honestly. At 4x the smallest
 *  series still occupies a quarter of the axis; beyond that it is a line near
 *  the floor again — the defect, merely smaller. This is deliberately stricter
 *  than SCALE_RATIO_LIMIT: detecting a problem and certifying a fix are
 *  different questions, and the observed chart (495 / 73 / 4) has NO two-axis
 *  grouping that passes — which is why splitting into separate charts exists. */
const GROUP_SPAN_LIMIT = 4;

export interface SeriesScale {
  key: string;
  min: number;
  max: number;
  /** Typical magnitude — the median |value|, robust to a single spike. */
  magnitude: number;
}

/** Per-series magnitudes from a chart's own rows. Non-numeric series are skipped. */
export function measureSeries(rows: Record<string, unknown>[], keys: string[]): SeriesScale[] {
  const out: SeriesScale[] = [];
  for (const key of keys) {
    const nums = rows
      .map((r) => r?.[key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (nums.length === 0) continue;
    const sorted = [...nums].map(Math.abs).sort((a, b) => a - b);
    const magnitude = sorted[Math.floor(sorted.length / 2)] ?? 0;
    out.push({
      key,
      min: Math.min(...nums),
      max: Math.max(...nums),
      // A series of all zeros has no magnitude to compare; treat it as 0 and let
      // the grouping below ignore it rather than dividing by it.
      magnitude,
    });
  }
  return out;
}

export interface ScaleGrouping {
  /** True when the series do NOT share a readable axis. */
  mismatched: boolean;
  /** Largest magnitude ratio between series. */
  ratio: number;
  /** Series partitioned into internally-comparable groups, largest first. */
  groups: string[][];
}

/**
 * Partition series into groups that can each honestly share an axis.
 *
 * Greedy from the largest magnitude: a series joins the current group while the
 * group stays within GROUP_SPAN_LIMIT, else it starts a new one. The number of
 * groups is the answer to "how many axes does this data actually need", which is
 * what decides between a dual axis and separate charts — rather than forcing
 * everything into two axes because two is what a dual axis has.
 */
export function groupByScale(scales: SeriesScale[]): ScaleGrouping {
  const usable = scales.filter((s) => s.magnitude > 0);
  if (usable.length < 2) return { mismatched: false, ratio: 1, groups: [] };
  const sorted = [...usable].sort((a, b) => b.magnitude - a.magnitude);
  const ratio = sorted[0]!.magnitude / sorted[sorted.length - 1]!.magnitude;
  if (ratio < SCALE_RATIO_LIMIT) return { mismatched: false, ratio, groups: [] };

  const groups: SeriesScale[][] = [];
  for (const s of sorted) {
    const current = groups[groups.length - 1];
    const head = current?.[0];
    if (current && head && head.magnitude / s.magnitude < GROUP_SPAN_LIMIT) current.push(s);
    else groups.push([s]);
  }
  return { mismatched: true, ratio, groups: groups.map((g) => g.map((s) => s.key)) };
}

/** `homeless_rate` -> "Homeless rate", for an axis that had no label to inherit. */
export function humanizeSeriesKey(key: string): string {
  const words = key.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface ChartRewrite {
  elementId: string;
  /** "dual-axis" when two groups fit two axes; "split" when each got its own chart. */
  kind: "dual-axis" | "split";
  ratio: number;
  groups: string[][];
  /** Ids of the charts created by a split (empty for a dual-axis rewrite). */
  createdIds: string[];
}

export interface SeriesScaleLint {
  rewritten: ChartRewrite[];
  /** Elements ADDED by a split, to be emitted as patches by the caller. */
  added: Record<string, unknown>;
}

const SINGLE_AXIS_TYPES = new Set(["LineChart", "AreaChart", "BarChart"]);

/**
 * Repair single-axis charts whose series do not share a scale.
 *
 * TWO groups become a DualAxisChart — the catalog ships it for exactly this, and
 * it keeps the series on one shared x so their co-movement stays visible.
 *
 * THREE OR MORE groups get one chart each, stacked. Two axes cannot show three
 * scales, and forcing them would leave a series flattened again — the original
 * defect, merely smaller. The observed King County chart is this case
 * (magnitudes 495 / 73 / 4).
 *
 * The split keeps the ORIGINAL element id and turns it into the LayoutColumn that
 * holds the new charts, so no parent needs rewiring and the tree stays reachable.
 */
export function lintSeriesScale(elements: Record<string, unknown>): SeriesScaleLint {
  const rewritten: ChartRewrite[] = [];
  const added: Record<string, unknown> = {};
  for (const [elementId, raw] of Object.entries(elements ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const el = raw as { type?: unknown; props?: Record<string, unknown>; children?: unknown };
    if (typeof el.type !== "string" || !SINGLE_AXIS_TYPES.has(el.type)) continue;
    const props = el.props;
    if (!props || typeof props !== "object") continue;
    const rows = props.data;
    const yKeys = props.y_keys;
    if (!Array.isArray(rows) || !Array.isArray(yKeys) || yKeys.length < 2) continue;

    const originalType = el.type;
    const keys = yKeys.filter((k): k is string => typeof k === "string");
    const { mismatched, ratio, groups } = groupByScale(
      measureSeries(rows as Record<string, unknown>[], keys)
    );
    if (!mismatched || groups.length < 2) continue;

    const labelMap = (props.label_map ?? {}) as Record<string, string>;
    const nameOf = (k: string) => labelMap[k] ?? humanizeSeriesKey(k);
    const axisLabel = (group: string[]) => group.map(nameOf).join(" · ");

    if (groups.length === 2) {
      const [left, right] = groups as [string[], string[]];
      el.type = "DualAxisChart";
      el.props = {
        title: props.title ?? null,
        data: rows,
        x_key: props.x_key,
        left_series: left,
        right_series: right,
        left_label: axisLabel(left),
        right_label: axisLabel(right),
        x_label: typeof props.x_key === "string" ? humanizeSeriesKey(props.x_key) : null,
        left_log: null,
        right_log: null,
      };
      rewritten.push({ elementId, kind: "dual-axis", ratio, groups, createdIds: [] });
      continue;
    }

    const createdIds: string[] = [];
    groups.forEach((group, i) => {
      const id = `${elementId}__scale_${i}`;
      added[id] = {
        type: originalType,
        props: {
          ...props,
          // One group per chart; the title says which measure it carries, since
          // the reader has lost the shared legend.
          title: props.title ? `${props.title} — ${axisLabel(group)}` : axisLabel(group),
          y_keys: group,
        },
        children: [],
      };
      createdIds.push(id);
    });
    // The original id becomes the container, so parents keep pointing at it.
    el.type = "LayoutColumn";
    el.props = { gap: 12 };
    (el as { children: string[] }).children = createdIds;
    rewritten.push({ elementId, kind: "split", ratio, groups, createdIds });
  }
  return { rewritten, added };
}

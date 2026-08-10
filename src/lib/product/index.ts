/**
 * Analysis Product host side (specs/analysis-product-2026-08-08.md):
 * validation of the raw declare_series/declare_value entries off the
 * envelope, the roles index the structured-first lints read instead of
 * re-inferring column relationships, and the Binding Catalog text the
 * composer receives in place of shape-guessing prose.
 *
 * Everything here is pure; invalid entries are dropped with a FindingIssue
 * (same posture as lib/findings validation — the sandbox runtime validates
 * too, but the prelude's degraded fallback stubs do not).
 */
import { z } from "zod";
import type {
  AnalysisProduct,
  SeriesEntry,
  SeriesMeasureRole,
  ValueEntry,
} from "@/lib/contracts/product";
import type { FindingIssue } from "@/lib/contracts/findings";

const AggregationSchema = z.union([
  z.object({
    fn: z.enum(["sum", "avg", "min", "max", "count"]),
    column: z.string().min(1),
    from: z.string().min(1),
  }),
  z.object({
    fn: z.literal("ratio"),
    numerator: z.string().min(1),
    denominator: z.string().min(1),
    from: z.string().min(1),
  }),
]);

const MeasureSchema = z.object({
  column: z.string().min(1),
  unit: z.string().optional(),
  of: z.string().optional(),
  screened_by: z.string().optional(),
  variant_of: z.string().optional(),
  // Malformed recipes are DROPPED, not fatal: a bad aggregates role costs
  // interactivity for that measure, never the series.
  aggregates: AggregationSchema.optional().catch(undefined),
});

const SeriesSchema = z.object({
  id: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())),
  roles: z.object({
    x: z.object({
      column: z.string().min(1),
      kind: z.enum(["temporal", "ordinal", "categorical"]),
    }),
    measures: z.array(MeasureSchema).min(1),
    count: z.object({ column: z.string().min(1) }).optional(),
    group: z.object({ column: z.string().min(1) }).optional(),
  }),
  rows_total: z.number().optional(),
});

const ValueSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  label: z.string().optional(),
  unit: z.string().optional(),
  of: z.string().optional(),
});

/** Validate the raw envelope entries into a typed product. Role columns must
 *  exist in the rows and every value needs context (of or label) — entries
 *  that fail are dropped with an issue, never thrown. */
export function parseProduct(
  rawSeries: unknown[] | undefined,
  rawValues: unknown[] | undefined
): { product: AnalysisProduct; issues: FindingIssue[] } {
  const issues: FindingIssue[] = [];
  const series: SeriesEntry[] = [];
  for (const raw of rawSeries ?? []) {
    const parsed = SeriesSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        kind: "invalid_series",
        detail: `declared series dropped — ${parsed.error.issues[0]?.path.join(".") ?? "?"}: ${parsed.error.issues[0]?.message ?? "malformed"}`,
      });
      continue;
    }
    const s = parsed.data;
    const columns = new Set<string>();
    for (const r of s.rows) for (const c of Object.keys(r)) columns.add(c);
    const roleCols = [
      s.roles.x.column,
      ...s.roles.measures.map((m) => m.column),
      ...(s.roles.count ? [s.roles.count.column] : []),
      ...(s.roles.group ? [s.roles.group.column] : []),
    ];
    const missing = s.rows.length > 0 ? roleCols.filter((c) => !columns.has(c)) : [];
    if (missing.length > 0) {
      issues.push({
        kind: "invalid_series",
        name: s.id,
        detail: `series ${s.id} declares role column(s) ${missing.join(", ")} absent from its rows — roles must describe the data they ship with`,
      });
      continue;
    }
    series.push(s as SeriesEntry);
  }
  const values: ValueEntry[] = [];
  for (const raw of rawValues ?? []) {
    const parsed = ValueSchema.safeParse(raw);
    if (!parsed.success || (parsed.data.of === undefined && parsed.data.label === undefined)) {
      issues.push({
        kind: "invalid_value",
        detail: parsed.success
          ? `declared value ${parsed.data.key} dropped — a standalone scalar needs of= (owning finding.field) or label= context`
          : `declared value dropped — ${parsed.error.issues[0]?.message ?? "malformed"}`,
      });
      continue;
    }
    values.push(parsed.data as ValueEntry);
  }
  return { product: { series, values }, issues };
}

/**
 * Merge per-step products into the investigation namespace (analysis-product
 * spec §7): series ids and value keys take the composer's `step_N_` data
 * prefix (matching the merged chart_data/results keys), while finding/check
 * REFERENCES (`of`, `screened_by`) take the manifest's `step_N.` prefix
 * (matching namespaceFindings) — the rename follows every reference, so
 * nothing dangles. `variant_of` names a column inside the same rows and is
 * untouched. Each step's entries are validated first; issues carry the step.
 */
export function mergeStepProducts(
  steps: Array<{ stepNo: number; series?: unknown[]; values?: unknown[] }>
): { product: AnalysisProduct; issues: FindingIssue[] } {
  const series: SeriesEntry[] = [];
  const values: ValueEntry[] = [];
  const issues: FindingIssue[] = [];
  for (const step of steps) {
    const parsed = parseProduct(step.series, step.values);
    issues.push(
      ...parsed.issues.map((i) => ({ ...i, detail: `step ${step.stepNo}: ${i.detail}` }))
    );
    const dataPrefix = `step_${step.stepNo}_`;
    const factPrefix = `step_${step.stepNo}.`;
    for (const s of parsed.product.series) {
      series.push({
        ...s,
        id: `${dataPrefix}${s.id}`,
        roles: {
          ...s.roles,
          measures: s.roles.measures.map((m) => ({
            ...m,
            ...(m.of !== undefined ? { of: `${factPrefix}${m.of}` } : {}),
            ...(m.screened_by !== undefined
              ? { screened_by: `${factPrefix}${m.screened_by}` }
              : {}),
          })),
        },
      });
    }
    for (const v of parsed.product.values) {
      values.push({
        ...v,
        key: `${dataPrefix}${v.key}`,
        ...(v.of !== undefined ? { of: `${factPrefix}${v.of}` } : {}),
      });
    }
  }
  return { product: { series, values }, issues };
}

// ── Roles index for structured-first lints ───────────────────────────

export interface SeriesScreenPair {
  /** The screened (nulls-where-excluded) measure column. */
  screenedCol: string;
  /** Raw sibling column, when declared via variant_of. */
  rawCol?: string;
  /** Declared check that owns the screen. */
  checkName: string;
}

export interface SeriesRoleInfo {
  xCol: string;
  xKind: string;
  countCol?: string;
  groupCol?: string;
  measures: SeriesMeasureRole[];
  screens: SeriesScreenPair[];
}

export type ProductRolesIndex = Map<string, SeriesRoleInfo>;

/** chart key → declared roles. The structured replacement for the
 *  X_KEYS/count-regex/_screened-morphology hunts in lib/findings/lints. */
export function productRolesIndex(series: SeriesEntry[]): ProductRolesIndex {
  const idx: ProductRolesIndex = new Map();
  for (const s of series) {
    idx.set(s.id, {
      xCol: s.roles.x.column,
      xKind: s.roles.x.kind,
      countCol: s.roles.count?.column,
      groupCol: s.roles.group?.column,
      measures: s.roles.measures,
      screens: s.roles.measures
        .filter((m) => m.screened_by)
        .map((m) => ({ screenedCol: m.column, rawCol: m.variant_of, checkName: m.screened_by! })),
    });
  }
  return idx;
}

/** Value keys owned by a finding (of-ref): withheld from the composer's
 *  binding vocabulary exactly like finding-field mirrors — the only path to
 *  an owned statistic is through its finding. */
export function ownedValueKeys(values: ValueEntry[]): Set<string> {
  return new Set(values.filter((v) => v.of !== undefined).map((v) => v.key));
}

/** Render form of a declared unit: percentage spellings collapse to the
 *  symbol (withUnit attaches "%" without a space); everything else passes
 *  through — the units vocabulary is open by design. */
function renderUnit(unit: string): string {
  return /^(pct|percent|percentage|%)$/i.test(unit) ? "%" : unit;
}

/** Result-key → declared unit, for resolution-time unit rendering ahead of
 *  key-name morphology (_pct/_pp suffixes): declare_value units by key, and
 *  each finding's unit on its value mirrors (`name` / `name_value` — the
 *  fields the finding's own unit describes; other fields keep their
 *  name-encoded units). */
export function declaredUnitMap(
  values: ValueEntry[],
  findings: Array<{ name: string; unit?: string }> = []
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const f of findings) {
    if (typeof f.unit !== "string" || f.unit.length === 0) continue;
    const base = f.name.replace(/^step_\d+\./, "");
    map[base] = renderUnit(f.unit);
    map[`${base}_value`] = renderUnit(f.unit);
  }
  for (const v of values) {
    if (typeof v.unit === "string" && v.unit.length > 0) map[v.key] = renderUnit(v.unit);
  }
  return map;
}

/** Columns the analysis DECLARED as category dimensions — group roles and
 *  categorical x roles. The DataController proposes filters from these ahead
 *  of cardinality sniffing (a declared dimension is a filter by intent, not
 *  by distinct-count coincidence). */
export function roleFilterColumns(series: SeriesEntry[]): Set<string> {
  const cols = new Set<string>();
  for (const s of series) {
    if (s.roles.group) cols.add(s.roles.group.column);
    if (s.roles.x.kind === "categorical") cols.add(s.roles.x.column);
  }
  return cols;
}

// ── Binding Catalog (spec §2) ────────────────────────────────────────

function describeMeasure(m: SeriesMeasureRole): string {
  const parts = [m.column];
  const attrs = [
    ...(m.unit ? [m.unit] : []),
    ...(m.of ? [`of finding ${m.of}`] : []),
    ...(m.screened_by ? [`screened by ${m.screened_by}`] : []),
    ...(m.variant_of ? [`variant of ${m.variant_of}`] : []),
  ];
  if (attrs.length > 0) parts.push(`(${attrs.join(", ")})`);
  return parts.join(" ");
}

/** One catalog line per declared series — typed identity for every
 *  $chartData binding, replacing shape inference from sampled rows. */
export function buildSeriesCatalogLines(series: SeriesEntry[]): string[] {
  return series.map((s) => {
    const r = s.roles;
    const segs = [
      `x: ${r.x.column} (${r.x.kind})`,
      `measures: ${r.measures.map(describeMeasure).join("; ")}`,
      ...(r.count ? [`count: ${r.count.column} (observations per row)`] : []),
      ...(r.group ? [`group: ${r.group.column}`] : []),
      `${s.rows_total ?? s.rows.length} rows`,
    ];
    return `- "$chartData:${s.id}" — ${segs.join("; ")}`;
  });
}

/** Catalog lines for standalone declared values ($result bindings that are
 *  NOT finding mirrors — those bind via $finding). */
export function buildValueCatalogLines(values: ValueEntry[]): string[] {
  return values
    .filter((v) => v.of === undefined)
    .map((v) => `- "$result:${v.key}" — ${v.label ?? v.key}${v.unit ? ` (${v.unit})` : ""}`);
}

/** The complete Series Catalog prompt block ("" when nothing is declared) —
 *  shared by the Ask and Investigate composers so the catalog prose can't
 *  drift between modes. */
export function buildCatalogSection(product: AnalysisProduct): string {
  if (product.series.length === 0) return "";
  const valueLines = buildValueCatalogLines(product.values);
  return `## Series Catalog
Each entry is a typed chart binding: its x column and kind, each measure with its unit and the finding/check it belongs to, and the count column attesting each row. Bind these by id; the roles are authoritative.
${buildSeriesCatalogLines(product.series).join("\n")}
${valueLines.length > 0 ? `\nDeclared standalone values:\n${valueLines.join("\n")}` : ""}
`;
}

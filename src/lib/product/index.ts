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

const MeasureSchema = z.object({
  column: z.string().min(1),
  unit: z.string().optional(),
  of: z.string().optional(),
  screened_by: z.string().optional(),
  variant_of: z.string().optional(),
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

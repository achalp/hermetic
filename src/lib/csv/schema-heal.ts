/**
 * Repair a CSVSchema that crossed an UNTYPED boundary — the profiler's JSON, or
 * a schema-cache entry written by an older build.
 *
 * `CSVColumn.meta` is a required discriminated union and every consumer switches
 * on `meta.kind`. A column that arrives with `meta: null` (an older remote
 * profiler wrote that for skipped GEOMETRY/BLOB columns) therefore detonates
 * far from its origin: `c.meta.kind` threw inside the question-suggestion
 * heuristics on page load, and would have thrown again in `formatColumnMeta`
 * while building any manifest prompt. Both `JSON.parse(...) as CSVSchema` and a
 * cache read assert a shape nobody checked, so the repair belongs at those
 * boundaries rather than as a null-guard at each of the dozen read sites.
 *
 * The repair is deliberately NOT a fabricated statistic: an unreadable column
 * becomes the `unprofiled` variant, which says "nothing was measured here" out
 * loud. Healing is identity for a valid schema, so it is safe to apply wherever
 * a schema enters typed code.
 */
import type { CSVSchema, CSVColumn, ColumnMeta, UnprofiledMeta } from "@/lib/contracts/data-schema";

const VALID_KINDS = new Set(["number", "date", "categorical", "boolean", "unprofiled"]);

function healMeta(meta: unknown): ColumnMeta | null {
  if (meta && typeof meta === "object" && VALID_KINDS.has((meta as ColumnMeta).kind)) {
    return meta as ColumnMeta;
  }
  return null;
}

/** Heal one column; returns the same object when nothing needed fixing. */
export function healColumnMeta(col: CSVColumn): CSVColumn {
  const healed = healMeta(col.meta);
  if (healed) return col;
  const unprofiled: UnprofiledMeta = {
    kind: "unprofiled",
    reason: "no profile recorded for this column",
  };
  return { ...col, meta: unprofiled };
}

/**
 * Heal every column's meta. Returns the SAME schema object when all of them are
 * already valid, so this costs nothing on the common path.
 */
export function healSchemaColumnMeta(schema: CSVSchema): CSVSchema {
  if (!Array.isArray(schema.columns)) return schema;
  let changed = false;
  const columns = schema.columns.map((col) => {
    const healed = healColumnMeta(col);
    if (healed !== col) changed = true;
    return healed;
  });
  return changed ? { ...schema, columns } : schema;
}

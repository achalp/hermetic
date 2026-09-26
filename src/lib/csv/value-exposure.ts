/**
 * Which categorical values a column profile may carry into model prompts.
 *
 * The profile is the model's only view of the data ("shape over samples"), and a
 * categorical column contributes literal labels: every value when there are ≤30,
 * else the top 10 with counts. For a dimension (plan, region, status) those
 * labels ARE the shape. For an identifier column (emails, names, account IDs)
 * they are not: every count is 1, so "top 10" is ten arbitrary individual
 * records, which tell the model nothing about the distribution and disclose
 * exactly the values a user most expects to stay local.
 *
 * Two rules:
 *  - Identifier-like columns (every value unique, or an email/phone/UUID/IP
 *    pattern) keep their shape (distinct count, pattern, lengths) and lose
 *    their values.
 *  - A top-values list never carries a value seen once. A singleton is a
 *    record, not a mode, and a top-10 padded with singletons is a tie-break
 *    over arbitrary rows. If nothing repeats, the list is withheld entirely.
 *
 * Applied at extraction (lib/csv/schema.ts) and at the schema-heal boundary
 * every Parquet profile and older cached schema crosses, so no prompt builder
 * needs its own guard.
 *
 * Known residual: a column with ≤30 distinct values lists them all, even in a
 * small file where some appear once. That list is how the model learns a
 * dimension's labels; it is kept.
 */
import type { CategoricalMeta } from "@/lib/contracts/data-schema";

/** Patterns whose values identify a person, device, or record rather than a group. */
const IDENTIFIER_PATTERNS = new Set(["email", "phone", "uuid", "ip_address"]);

export function isIdentifierLike(meta: CategoricalMeta): boolean {
  if (meta.is_unique) return true;
  return !!meta.detected_pattern && IDENTIFIER_PATTERNS.has(meta.detected_pattern);
}

/**
 * Drop values that would reach a prompt as individual records. Returns the SAME
 * object when nothing is dropped, so it costs nothing on the common path.
 */
export function withholdIdentifierValues(meta: CategoricalMeta): CategoricalMeta {
  if (meta.values_withheld) return meta;
  if (isIdentifierLike(meta)) {
    const { distinct_values: _dv, top_values: _tv, ...rest } = meta;
    return { ...rest, values_withheld: true };
  }
  const top = meta.top_values;
  if (!top || top.every((t) => t.count > 1)) return meta;
  const repeated = top.filter((t) => t.count > 1);
  if (repeated.length > 0) return { ...meta, top_values: repeated };
  // Nothing repeats (e.g. unique-with-nulls, which the Parquet profiler's
  // row-count-based is_unique misses): every listed value is a record.
  const { top_values: _tv, ...rest } = meta;
  return { ...rest, values_withheld: true };
}

import type { CSVSchema } from "@/lib/types";

/**
 * Produces a deterministic fingerprint from a schema's column names + dtypes.
 * Used for fast schema comparison without deep-comparing full column metadata.
 */
export function schemaFingerprint(schema: CSVSchema): string {
  return schema.columns
    .map((c) => `${c.name}:${c.dtype}`)
    .sort()
    .join("|");
}

/**
 * Returns true when every column in `expected` exists in `actual` with the same dtype.
 * Extra columns in `actual` are OK — they won't break the saved Python code.
 */
export function schemasCompatible(expected: CSVSchema, actual: CSVSchema): boolean {
  const actualMap = new Map(actual.columns.map((c) => [c.name, c.dtype]));
  return expected.columns.every((col) => actualMap.get(col.name) === col.dtype);
}

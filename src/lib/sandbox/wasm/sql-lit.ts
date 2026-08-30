/**
 * Escape a host path (or any text) for a DuckDB single-quoted string literal.
 *
 * Shared by every host-side DuckDB caller so the escaping lives in ONE place:
 * these queries are built from filesystem paths the user chose, and a path may
 * legitimately contain an apostrophe.
 */
export function sqlLit(value: string): string {
  return value.replace(/'/g, "''");
}

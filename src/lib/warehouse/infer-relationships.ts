import type { WarehouseTableSchema } from "@/lib/types";

/**
 * Infer foreign key relationships from column naming conventions.
 * Works for databases without native FK support (ClickHouse, BigQuery).
 *
 * Heuristics:
 * - A column named `<table>_id` in table A → references `id` column in table `<table>`
 * - A column named `<table>Id` (camelCase) → same
 * - A column named `id_<table>` → same
 * - Only infers if both the referenced table and column exist
 */
export function inferRelationships(schemas: WarehouseTableSchema[]): WarehouseTableSchema[] {
  const tableNames = new Set(schemas.map((s) => s.name));
  const tableColumnSets = new Map(
    schemas.map((s) => [s.name, new Set(s.columns.map((c) => c.name))])
  );

  // Build lookup: normalized table name → actual table name
  const normalizedTableLookup = new Map<string, string>();
  for (const name of tableNames) {
    normalizedTableLookup.set(name.toLowerCase(), name);
    // Also try singular forms: "orders" → "order", "categories" → "category"
    const lower = name.toLowerCase();
    if (lower.endsWith("ies")) {
      normalizedTableLookup.set(lower.slice(0, -3) + "y", name);
    } else if (lower.endsWith("ses")) {
      normalizedTableLookup.set(lower.slice(0, -2), name);
    } else if (lower.endsWith("s") && !lower.endsWith("ss")) {
      normalizedTableLookup.set(lower.slice(0, -1), name);
    }
    // And vice versa: "order" → "orders"
    normalizedTableLookup.set(lower + "s", name);
  }

  return schemas.map((schema) => {
    // Skip if table already has FKs (e.g., from PostgreSQL)
    if (schema.foreign_keys && schema.foreign_keys.length > 0) {
      return schema;
    }

    const inferredFKs: { column: string; references_table: string; references_column: string }[] =
      [];

    for (const col of schema.columns) {
      const colLower = col.name.toLowerCase();

      // Pattern 1: <table>_id or <table>_key
      for (const suffix of ["_id", "_key", "_code"]) {
        if (colLower.endsWith(suffix)) {
          const prefix = colLower.slice(0, -suffix.length);
          if (prefix === "" || prefix === schema.name.toLowerCase()) continue;

          const refTable = normalizedTableLookup.get(prefix);
          if (refTable && refTable !== schema.name) {
            // Check the referenced table has an "id" column (or the prefix column itself)
            const refCols = tableColumnSets.get(refTable);
            const refCol = refCols?.has("id")
              ? "id"
              : refCols?.has(col.name)
                ? col.name
                : refCols?.has("ID")
                  ? "ID"
                  : null;
            if (refCol) {
              inferredFKs.push({
                column: col.name,
                references_table: refTable,
                references_column: refCol,
              });
            }
          }
          break;
        }
      }

      // Pattern 2: camelCase like menuId, categoryKey
      if (!inferredFKs.some((fk) => fk.column === col.name)) {
        const camelMatch = col.name.match(/^(.+?)(Id|Key|Code)$/);
        if (camelMatch) {
          const prefix = camelMatch[1].toLowerCase();
          if (prefix === schema.name.toLowerCase()) continue;

          const refTable = normalizedTableLookup.get(prefix);
          if (refTable && refTable !== schema.name) {
            const refCols = tableColumnSets.get(refTable);
            const refCol = refCols?.has("id") ? "id" : refCols?.has("ID") ? "ID" : null;
            if (refCol) {
              inferredFKs.push({
                column: col.name,
                references_table: refTable,
                references_column: refCol,
              });
            }
          }
        }
      }
    }

    if (inferredFKs.length === 0) return schema;

    return {
      ...schema,
      foreign_keys: inferredFKs,
    };
  });
}

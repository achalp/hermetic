import "server-only";
import { createHash } from "node:crypto";
import type { WarehouseConnectionConfig, WarehouseTableInfo } from "@/lib/types";

/**
 * Source-agnostic warehouse schema caching helpers.
 *
 * The cheap freshness probe reuses `listTables()` — already called on every
 * connect and far cheaper than the full `introspectAllTables()` (which fetches
 * every column + PK/FK for every table, the ~1-2 min "connect" cost). The
 * fingerprint below is STRUCTURAL (table set + per-table column count), so it
 * changes when a table or column is added/dropped but NOT on ordinary data
 * writes — because the cached artifact (the table SCHEMAS) is structural, not
 * data-volume. Zero per-engine code; a column rename / retype at the same count
 * is the blind spot the manual "refresh schema" control covers.
 */

/**
 * The identity that determines the schema — deliberately WITHOUT secrets
 * (password / token / credentials). Two connections to the same
 * host+database+schema share a cache entry; the password is irrelevant to what
 * the schema looks like and must not sit in a cache key.
 */
export function warehouseSourceKey(config: WarehouseConnectionConfig): string {
  const c = config as unknown as Record<string, unknown>;
  const parts = [
    config.type,
    c.host,
    c.port,
    c.projectId,
    c.dataset,
    c.database,
    c.catalog,
    c.schema,
    c.serverHostname,
    c.httpPath,
    c.account,
    c.user,
  ].filter((v) => v !== undefined && v !== null && v !== "");
  return `warehouse:${parts.join(":")}`;
}

/**
 * Cheap freshness fingerprint from the already-fetched table listing: the
 * sorted set of `schema.table:columnCount`. Row-count estimates are excluded
 * on purpose — they drift with every insert and would defeat the cache while
 * telling us nothing about the (structural) schema.
 */
export function warehouseTablesFingerprint(tables: WarehouseTableInfo[]): string {
  const norm = tables
    .map((t) => `${t.schema}.${t.name}:${t.column_count ?? ""}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(norm).digest("hex");
}

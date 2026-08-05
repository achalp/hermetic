/**
 * Shared warehouse introspection.
 *
 * The web connect route cached the expensive introspection (schema-cache
 * keyed by warehouseSourceKey, fingerprint-gated on the cheap table listing)
 * and enriched it with inferred relationships, while MCP connect_source
 * re-ran raw `introspectAllTables()` on every connect and inferred nothing.
 * This is the ONE implementation both consume: `inferRelationships` runs
 * inside the extract so the cached artifact is the finished,
 * relationship-enriched schema.
 */
import type { WarehouseConnector } from "./connector";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type { WarehouseTableInfo, WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import { resolveWithCache } from "@/lib/schema-cache";
import { inferRelationships } from "./infer-relationships";
import { warehouseSourceKey, warehouseTablesFingerprint } from "./schema-fingerprint";

export interface WarehouseIntrospection {
  tables: WarehouseTableInfo[];
  tableSchemas: WarehouseTableSchema[];
  /** True when the schemas came from the fingerprint-validated cache. */
  fromCache: boolean;
}

/**
 * Introspect all table schemas (columns, PKs, FKs) — the expensive step —
 * through the schema cache. `force` is the "ignore cache / re-read" control;
 * `tables` lets a caller that already fetched the listing (every connect
 * does) skip a second round trip.
 */
export async function introspectWithCache(
  connector: WarehouseConnector,
  config: WarehouseConnectionConfig,
  opts: { force?: boolean; tables?: WarehouseTableInfo[] } = {}
): Promise<WarehouseIntrospection> {
  const tables = opts.tables ?? (await connector.listTables());
  const resolved = await resolveWithCache<WarehouseTableSchema[]>({
    sourceKey: warehouseSourceKey(config),
    force: opts.force,
    fingerprint: async () => warehouseTablesFingerprint(tables),
    extract: async () => inferRelationships(await connector.introspectAllTables()),
  });
  return { tables, tableSchemas: resolved.artifact, fromCache: resolved.status === "hit" };
}

import type { StoredWarehouse } from "@/lib/contracts/storage-types";
import { CSV_TTL_MS } from "@/lib/constants";
import { isIdleExpired, touch } from "@/lib/store-ttl";
import type { WarehouseConnector } from "./connector";
import { stateNamespace } from "@/lib/state-store";

const store = stateNamespace<StoredWarehouse>("warehouse");
const connectors = stateNamespace<WarehouseConnector>("warehouse-connectors");

export function storeWarehouse(warehouse: StoredWarehouse, connector: WarehouseConnector): void {
  store.set(warehouse.warehouseId, warehouse);
  connectors.set(warehouse.warehouseId, connector);
}

export function getStoredWarehouse(warehouseId: string): StoredWarehouse | undefined {
  const entry = store.get(warehouseId);
  if (!entry) return undefined;
  const now = Date.now();
  // Sliding idle window + active-run pin (see lib/store-ttl.ts): a connection is
  // never dropped mid-session or during a long query it's servicing.
  if (isIdleExpired(entry, entry.createdAt, CSV_TTL_MS, now)) {
    removeWarehouse(warehouseId);
    return undefined;
  }
  touch(entry, now);
  return entry;
}

export function getWarehouseConnector(warehouseId: string): WarehouseConnector | undefined {
  const wh = getStoredWarehouse(warehouseId);
  if (!wh) return undefined;
  return connectors.get(warehouseId);
}

/**
 * Active sweep (see lib/store-sweeper.ts): expired entries previously lived
 * until the next lazy read — including their LIVE connector pools (open
 * sockets, credentialed sessions), which never closed if the warehouse id
 * was never accessed again after its TTL.
 */
export function sweepExpiredWarehouses(): number {
  const now = Date.now();
  let swept = 0;
  for (const [id, entry] of store) {
    if (isIdleExpired(entry, entry.createdAt, CSV_TTL_MS, now)) {
      removeWarehouse(id); // closes the connector too
      swept++;
    }
  }
  return swept;
}

export function removeWarehouse(warehouseId: string): void {
  const connector = connectors.get(warehouseId);
  if (connector) {
    connector.close().catch(() => {});
    connectors.delete(warehouseId);
  }
  store.delete(warehouseId);
}

/**
 * Update dbt manifest path on a stored warehouse and re-apply enrichment to
 * the in-memory schemas. Returns the updated stored entry, or undefined if
 * the warehouse is not in the store.
 */
export async function setDbtManifestPath(
  warehouseId: string,
  manifestPath: string | null
): Promise<{ stored: StoredWarehouse; enrichedTableCount: number } | undefined> {
  const entry = store.get(warehouseId);
  if (!entry) return undefined;

  // Wipe any prior dbt enrichment by clearing description fields (defensive —
  // re-introspecting would also work but is slower)
  for (const t of entry.tableSchemas) {
    delete t.description;
    for (const c of t.columns) delete c.description;
  }

  if (!manifestPath) {
    delete entry.dbtManifestPath;
    return { stored: entry, enrichedTableCount: 0 };
  }

  const { loadDbtManifest, applyDbtMetadata } = await import("./dbt-metadata");
  const index = await loadDbtManifest(manifestPath);

  // Snowflake stores `database`, BigQuery `projectId`, Databricks `catalog`,
  // Trino `catalog` — try each in turn for matching dbt manifest entries.
  const config = entry.config as { database?: string; projectId?: string; catalog?: string };
  const dbName = config.database ?? config.projectId ?? config.catalog;

  const enriched = applyDbtMetadata(entry.tableSchemas, index, dbName);
  entry.dbtManifestPath = manifestPath;
  return { stored: entry, enrichedTableCount: enriched };
}

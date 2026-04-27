import type { StoredWarehouse } from "@/lib/types";
import { CSV_TTL_MS } from "@/lib/constants";
import type { WarehouseConnector } from "./connector";

const globalStore = globalThis as unknown as {
  __warehouseStore?: Map<string, StoredWarehouse>;
  __warehouseConnectors?: Map<string, WarehouseConnector>;
};
if (!globalStore.__warehouseStore) {
  globalStore.__warehouseStore = new Map();
}
if (!globalStore.__warehouseConnectors) {
  globalStore.__warehouseConnectors = new Map();
}
const store = globalStore.__warehouseStore;
const connectors = globalStore.__warehouseConnectors;

export function storeWarehouse(warehouse: StoredWarehouse, connector: WarehouseConnector): void {
  store.set(warehouse.warehouseId, warehouse);
  connectors.set(warehouse.warehouseId, connector);
}

export function getStoredWarehouse(warehouseId: string): StoredWarehouse | undefined {
  const entry = store.get(warehouseId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CSV_TTL_MS) {
    removeWarehouse(warehouseId);
    return undefined;
  }
  return entry;
}

export function getWarehouseConnector(warehouseId: string): WarehouseConnector | undefined {
  const wh = getStoredWarehouse(warehouseId);
  if (!wh) return undefined;
  return connectors.get(warehouseId);
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

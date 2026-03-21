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

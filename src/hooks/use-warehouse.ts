"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { WarehouseConnectionConfig, WarehouseType } from "@/lib/contracts/connection-configs";
import type { WarehouseTableInfo, WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import {
  connectWarehouse as apiConnect,
  disconnectWarehouse,
  getSavedConnections,
  deleteSavedConnection,
  renameSavedConnection,
  type SavedConnectionInfo,
} from "@/app/lib/api";

interface WarehouseState {
  warehouseId: string | null;
  warehouseType: WarehouseType | null;
  isConnected: boolean;
  isConnecting: boolean;
  tables: WarehouseTableInfo[];
  tableSchemas: WarehouseTableSchema[];
  tableCount: number;
  totalColumns: number;
  error: string | null;
  savedConnections: SavedConnectionInfo[];
}

export function useWarehouse() {
  const [state, setState] = useState<WarehouseState>({
    warehouseId: null,
    warehouseType: null,
    isConnected: false,
    isConnecting: false,
    tables: [],
    tableSchemas: [],
    tableCount: 0,
    totalColumns: 0,
    error: null,
    savedConnections: [],
  });

  // Load saved connections on mount
  useEffect(() => {
    const controller = new AbortController();
    getSavedConnections(controller.signal)
      .then((connections) => {
        if (!controller.signal.aborted) {
          setState((prev) => ({ ...prev, savedConnections: connections }));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // The last config connected with — lets the schema sidebar's "refresh"
  // re-introspect the active warehouse (with force) without re-entering it.
  const lastConfigRef = useRef<WarehouseConnectionConfig | null>(null);

  const connect = useCallback(
    async (config: WarehouseConnectionConfig, force?: boolean) => {
      lastConfigRef.current = config;
      setState((prev) => ({ ...prev, isConnecting: true, error: null }));
      try {
        const result = await apiConnect(config, force);
        // Refresh saved connections (the connect route auto-saves)
        const connections = await getSavedConnections().catch(() => state.savedConnections);
        setState((prev) => ({
          ...prev,
          warehouseId: result.warehouse_id,
          warehouseType: config.type,
          isConnected: true,
          isConnecting: false,
          tables: result.tables,
          tableSchemas: result.table_schemas,
          tableCount: result.table_count,
          totalColumns: result.total_columns,
          error: null,
          savedConnections: connections,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isConnecting: false,
          error: err instanceof Error ? err.message : "Connection failed",
        }));
      }
    },
    [state.savedConnections]
  );

  const disconnect = useCallback(async () => {
    if (state.warehouseId) {
      await disconnectWarehouse(state.warehouseId).catch(() => {});
    }
    setState((prev) => ({
      ...prev,
      warehouseId: null,
      warehouseType: null,
      isConnected: false,
      isConnecting: false,
      tables: [],
      tableSchemas: [],
      tableCount: 0,
      totalColumns: 0,
      error: null,
    }));
  }, [state.warehouseId]);

  const reset = useCallback(() => {
    if (state.warehouseId) {
      disconnectWarehouse(state.warehouseId).catch(() => {});
    }
    setState((prev) => ({
      ...prev,
      warehouseId: null,
      warehouseType: null,
      isConnected: false,
      isConnecting: false,
      tables: [],
      tableSchemas: [],
      tableCount: 0,
      totalColumns: 0,
      error: null,
    }));
  }, [state.warehouseId]);

  const deleteSaved = useCallback(async (id: string) => {
    try {
      await deleteSavedConnection(id);
      setState((prev) => ({
        ...prev,
        savedConnections: prev.savedConnections.filter((c) => c.id !== id),
      }));
    } catch {
      // non-fatal
    }
  }, []);

  const renameSaved = useCallback(async (id: string, name: string) => {
    // Optimistic: update locally, then persist. Display falls back to the
    // auto label when the friendly name is cleared.
    setState((prev) => ({
      ...prev,
      savedConnections: prev.savedConnections.map((c) =>
        c.id === id ? { ...c, name: name.trim() || undefined } : c
      ),
    }));
    try {
      await renameSavedConnection(id, name);
    } catch {
      // non-fatal — local state already reflects the intent
    }
  }, []);

  /** Re-introspect the active warehouse, bypassing the schema cache. */
  const refresh = useCallback(async () => {
    if (lastConfigRef.current) await connect(lastConfigRef.current, true);
  }, [connect]);

  return { ...state, connect, disconnect, reset, deleteSaved, renameSaved, refresh };
}

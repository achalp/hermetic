"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  WarehouseConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseType,
} from "@/lib/types";
import {
  connectWarehouse as apiConnect,
  disconnectWarehouse,
  getSavedConnections,
  deleteSavedConnection,
  type SavedConnectionInfo,
} from "@/lib/api";

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
  const loaded = useRef(false);

  // Load saved connections on mount
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const controller = new AbortController();
    getSavedConnections(controller.signal)
      .then((connections) => {
        setState((prev) => ({ ...prev, savedConnections: connections }));
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const connect = useCallback(
    async (config: WarehouseConnectionConfig) => {
      setState((prev) => ({ ...prev, isConnecting: true, error: null }));
      try {
        const result = await apiConnect(config);
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

  return { ...state, connect, disconnect, reset, deleteSaved };
}

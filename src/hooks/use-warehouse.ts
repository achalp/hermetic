"use client";

import { useState, useCallback } from "react";
import type { WarehouseConnectionConfig, WarehouseTableInfo, WarehouseType } from "@/lib/types";
import { connectWarehouse as apiConnect, disconnectWarehouse } from "@/lib/api";

interface WarehouseState {
  warehouseId: string | null;
  warehouseType: WarehouseType | null;
  isConnected: boolean;
  isConnecting: boolean;
  tables: WarehouseTableInfo[];
  tableCount: number;
  totalColumns: number;
  error: string | null;
}

export function useWarehouse() {
  const [state, setState] = useState<WarehouseState>({
    warehouseId: null,
    warehouseType: null,
    isConnected: false,
    isConnecting: false,
    tables: [],
    tableCount: 0,
    totalColumns: 0,
    error: null,
  });

  const connect = useCallback(async (config: WarehouseConnectionConfig) => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
    try {
      const result = await apiConnect(config);
      setState({
        warehouseId: result.warehouse_id,
        warehouseType: config.type,
        isConnected: true,
        isConnecting: false,
        tables: result.tables,
        tableCount: result.table_count,
        totalColumns: result.total_columns,
        error: null,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isConnecting: false,
        error: err instanceof Error ? err.message : "Connection failed",
      }));
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (state.warehouseId) {
      await disconnectWarehouse(state.warehouseId).catch(() => {});
    }
    setState({
      warehouseId: null,
      warehouseType: null,
      isConnected: false,
      isConnecting: false,
      tables: [],
      tableCount: 0,
      totalColumns: 0,
      error: null,
    });
  }, [state.warehouseId]);

  const reset = useCallback(() => {
    if (state.warehouseId) {
      disconnectWarehouse(state.warehouseId).catch(() => {});
    }
    setState({
      warehouseId: null,
      warehouseType: null,
      isConnected: false,
      isConnecting: false,
      tables: [],
      tableCount: 0,
      totalColumns: 0,
      error: null,
    });
  }, [state.warehouseId]);

  return { ...state, connect, disconnect, reset };
}

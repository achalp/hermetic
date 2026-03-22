"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  WarehouseConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseType,
} from "@/lib/types";
import { connectWarehouse as apiConnect, disconnectWarehouse, getWarehousePreset } from "@/lib/api";

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
  /** Pre-configured connection from env vars (null = none, undefined = loading) */
  preset: WarehouseConnectionConfig | null | undefined;
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
    preset: undefined,
  });
  const presetLoaded = useRef(false);

  // Load preset from env vars on mount
  useEffect(() => {
    if (presetLoaded.current) return;
    presetLoaded.current = true;
    const controller = new AbortController();
    getWarehousePreset(controller.signal)
      .then((result) => {
        setState((prev) => ({ ...prev, preset: result.preset }));
      })
      .catch(() => {
        setState((prev) => ({ ...prev, preset: null }));
      });
    return () => controller.abort();
  }, []);

  const connect = useCallback(async (config: WarehouseConnectionConfig) => {
    setState((prev) => ({ ...prev, isConnecting: true, error: null }));
    try {
      const result = await apiConnect(config);
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
      }));
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

  return { ...state, connect, disconnect, reset };
}

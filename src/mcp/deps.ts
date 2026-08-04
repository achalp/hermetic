/**
 * The MCP harness's dependency seam (mcp-server spec §4, M1).
 *
 * Every tool handler takes an `McpDeps` — never imports a lib function
 * directly — so tests exercise handlers with fakes and the lib surface the
 * harness consumes is enumerated in ONE place. `realDeps()` is the only
 * binding to the real libraries; if a lib module ever grows a framework
 * dependency, this file is where the harness-purity grep will catch it.
 */
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV } from "@/lib/csv/storage";
import { createConnector } from "@/lib/warehouse/connector";
import { loadConnections } from "@/lib/warehouse/persist-env";
import { assertReadOnlySql } from "@/lib/warehouse/sql-guard";
import { storeWarehouse, getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { runPatchStream } from "@/lib/pipeline/patch-stream";
import { runAskQuery } from "@/lib/pipeline/run-ask-query";
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import { persistHistoryEntry } from "@/lib/history/persist";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { CODE_GEN_MODEL, UI_COMPOSE_MODEL } from "@/lib/constants";
import type { WarehouseState } from "@/lib/pipeline/validate-request";

export interface McpDeps {
  parseCSV: typeof parseCSV;
  extractSchema: typeof extractSchema;
  storeCSV: typeof storeCSV;
  createConnector: typeof createConnector;
  loadConnections: typeof loadConnections;
  assertReadOnlySql: typeof assertReadOnlySql;
  storeWarehouse: typeof storeWarehouse;
  /** Composed accessor: the {warehouse, connector} pair runAskQuery takes. */
  getWarehouseState: (warehouseId: string) => WarehouseState | undefined;
  runPatchStream: typeof runPatchStream;
  runAskQuery: typeof runAskQuery;
  assembleSpecFromPatches: typeof assembleSpecFromPatches;
  persistHistoryEntry: typeof persistHistoryEntry;
  getActiveSandboxRuntime: typeof getActiveSandboxRuntime;
  models: { codeGen: string; uiCompose: string };
}

export function realDeps(): McpDeps {
  return {
    parseCSV,
    extractSchema,
    storeCSV,
    createConnector,
    loadConnections,
    assertReadOnlySql,
    storeWarehouse,
    getWarehouseState: (warehouseId) => {
      const warehouse = getStoredWarehouse(warehouseId);
      const connector = getWarehouseConnector(warehouseId);
      return warehouse && connector ? { warehouse, connector } : undefined;
    },
    runPatchStream,
    runAskQuery,
    assembleSpecFromPatches,
    persistHistoryEntry,
    getActiveSandboxRuntime,
    models: { codeGen: CODE_GEN_MODEL, uiCompose: UI_COMPOSE_MODEL },
  };
}

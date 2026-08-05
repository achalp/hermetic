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
import {
  storeCSV,
  getCSVContent,
  getGeoJSONContent,
  storeLocalFileRef,
  storeGeoJSON,
} from "@/lib/csv/storage";
import { createConnector } from "@/lib/warehouse/connector";
import { loadConnections } from "@/lib/warehouse/persist-env";
import { assertReadOnlySql } from "@/lib/warehouse/sql-guard";
import { storeWarehouse, getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { runPatchStream } from "@/lib/pipeline/patch-stream";
import { runAskQuery } from "@/lib/pipeline/run-ask-query";
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import { persistHistoryEntry } from "@/lib/history/persist";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { executeSandbox } from "@/lib/sandbox";
import { collectGroundedValues, verifyGrounding } from "@/lib/pipeline/grounding";
import { validateSpec, catalogComponents } from "@/lib/catalog";
import { isSafeParquetUrl } from "@/lib/parquet/duckdb-source";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { extractRemoteParquetSchema, extractParquetSchema } from "@/lib/parquet/schema-extractor";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { getFileInfo } from "@/lib/local-files/browser";
import { parseExcelMeta, sheetToCSV } from "@/lib/excel/parser";
import { parseGeoJSON, isGeoJSONObject } from "@/lib/geojson/parser";
import { toCSVText } from "@/lib/csv/parser";

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
  getCachedArtifacts: typeof getCachedArtifacts;
  getActiveSandboxRuntime: typeof getActiveSandboxRuntime;
  getCSVContent: typeof getCSVContent;
  getGeoJSONContent: typeof getGeoJSONContent;
  executeSandbox: typeof executeSandbox;
  collectGroundedValues: typeof collectGroundedValues;
  verifyGrounding: typeof verifyGrounding;
  validateSpec: typeof validateSpec;
  catalogComponentNames: () => string[];
  isSafeParquetUrl: typeof isSafeParquetUrl;
  normalizeRemoteParquetUrl: typeof normalizeRemoteParquetUrl;
  extractRemoteParquetSchema: typeof extractRemoteParquetSchema;
  storeRemoteParquetRef: typeof storeRemoteParquetRef;
  extractParquetSchema: typeof extractParquetSchema;
  storeLocalFileRef: typeof storeLocalFileRef;
  getFileInfo: typeof getFileInfo;
  parseExcelMeta: typeof parseExcelMeta;
  sheetToCSV: typeof sheetToCSV;
  parseGeoJSON: typeof parseGeoJSON;
  isGeoJSONObject: typeof isGeoJSONObject;
  storeGeoJSON: typeof storeGeoJSON;
  toCSVText: typeof toCSVText;
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
    getCachedArtifacts,
    getActiveSandboxRuntime,
    getCSVContent,
    getGeoJSONContent,
    executeSandbox,
    collectGroundedValues,
    verifyGrounding,
    validateSpec,
    catalogComponentNames: () => Object.keys(catalogComponents),
    isSafeParquetUrl,
    normalizeRemoteParquetUrl,
    extractRemoteParquetSchema,
    storeRemoteParquetRef,
    extractParquetSchema,
    storeLocalFileRef,
    getFileInfo,
    parseExcelMeta,
    sheetToCSV,
    parseGeoJSON,
    isGeoJSONObject,
    storeGeoJSON,
    toCSVText,
    models: { codeGen: CODE_GEN_MODEL, uiCompose: UI_COMPOSE_MODEL },
  };
}

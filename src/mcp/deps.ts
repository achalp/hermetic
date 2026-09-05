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
  getStoredCSV,
  restoreStoredCSV,
  storeLocalFileRef,
  storeGeoJSON,
} from "@/lib/csv/storage";
import { createConnector } from "@/lib/warehouse/connector";
import { loadConnections } from "@/lib/warehouse/persist-env";
import { assertReadOnlySql } from "@/lib/warehouse/sql-guard";
import { storeWarehouse, getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { runPatchStream } from "@/lib/pipeline/patch-stream";
import { stopRun } from "@/lib/pipeline/run-control";
import { runAskQuery } from "@/lib/pipeline/run-ask-query";
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import { persistHistoryEntry } from "@/lib/history/persist";
import { loadHistoryEntry } from "@/lib/history/storage";
import { exportDashboardHtml, exportAppTemplateHtml } from "@/lib/export/html-export";
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
import { ingestFile, makeIngest, type IngestFn } from "@/lib/sources/ingest";
import { introspectWithCache } from "@/lib/warehouse/introspect";
import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { connectDatasetManifest } from "@/lib/manifest/connect";
import { ensureManifestEntities, type MaterializeDeps } from "@/lib/manifest/ensure";
import { fetchManifestText } from "@/lib/manifest/fetch";
import { getManifestStore, type ManifestRecord } from "@/lib/manifest/store";
import { buildSelectionPrompt, parseSelection } from "@/lib/manifest/select";
import { MANIFEST_EAGER_BUDGET_MS } from "@/lib/manifest/shared";
import { extractRemoteParquetSchemaBatch } from "@/lib/parquet/schema-extractor";
import { readSchemaCache, writeSchemaCache } from "@/lib/schema-cache";
import { getModel } from "@/lib/llm/client";
import { trackRouteCost } from "@/lib/cost/epilogue";
import { logger, errMessage } from "@/lib/logger";

import { getActiveModels } from "@/lib/runtime-config";
import type { WarehouseState } from "@/lib/pipeline/validate-request";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { CSVSchema as CSVSchemaT } from "@/lib/contracts/data-schema";

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
  /** Host-cancellation seam: aborts a run's LLM streams and kills its containers. */
  stopRun: typeof stopRun;
  runAskQuery: typeof runAskQuery;
  assembleSpecFromPatches: typeof assembleSpecFromPatches;
  persistHistoryEntry: typeof persistHistoryEntry;
  loadHistoryEntry: typeof loadHistoryEntry;
  exportDashboardHtml: typeof exportDashboardHtml;
  exportAppTemplateHtml: typeof exportAppTemplateHtml;
  getCachedArtifacts: typeof getCachedArtifacts;
  getActiveSandboxRuntime: typeof getActiveSandboxRuntime;
  getCSVContent: typeof getCSVContent;
  /** Liveness probe: undefined once the sliding idle TTL expired the entry. */
  getStoredCSV: typeof getStoredCSV;
  /** Re-seed a store index entry from persisted metadata (source-persist). */
  restoreStoredCSV: typeof restoreStoredCSV;
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
  /**
   * The shared file-ingestion pipeline (lib/sources/ingest.ts) and cached,
   * relationship-enriched warehouse introspection (lib/warehouse/
   * introspect.ts). Optional so fake-deps suites written before this seam
   * keep compiling: realDeps() always supplies them, and connect_source
   * falls back to assembling the ingest from the granular deps above
   * (`ingestFromDeps`) / raw introspection when they are absent.
   */
  ingestFile?: IngestFn;
  introspectWithCache?: typeof introspectWithCache;
  /**
   * Dataset-manifest parity (spec §6): the composed seams MCP needs because it
   * has no browser client to drive the manifest UI. Each mirrors a web route's
   * deps assembly EXACTLY (connect route / select route / the shared
   * materializer), so cache keys, fingerprints and registration cannot fork
   * between the two doors. Optional so fake-deps suites written before this
   * seam keep compiling; realDeps() always supplies them.
   */
  connectManifest?: (args: { url: string; creds?: RemoteCreds }) => Promise<ManifestRecord>;
  getManifestRecord?: (manifestId: string) => ManifestRecord | undefined;
  selectManifestEntities?: (
    record: ManifestRecord,
    question: string
  ) => Promise<{ entities: string[]; usedFallback: boolean }>;
  ensureManifestEntitiesReady?: (
    record: ManifestRecord,
    names: string[]
  ) => Promise<{
    ready: { name: string; csvId: string }[];
    unavailable: { name: string; reason: string }[];
  }>;
  models: { codeGen: string; uiCompose: string };
}

/**
 * The ingest connect_source uses: the injected one when present, else one
 * assembled from the granular deps — so pre-existing fake-deps suites flow
 * their fakes through the shared pipeline unchanged. Capability deps the
 * granular seam does not carry (materialize / warm sandbox / recents) are
 * simply absent in the fallback; their policy flags no-op.
 */
export function ingestFromDeps(deps: McpDeps): IngestFn {
  return (
    deps.ingestFile ??
    makeIngest({
      parseCSV: deps.parseCSV,
      toCSVText: deps.toCSVText,
      extractSchema: deps.extractSchema,
      storeCSV: deps.storeCSV,
      storeGeoJSON: deps.storeGeoJSON,
      storeLocalFileRef: deps.storeLocalFileRef,
      parseExcelMeta: deps.parseExcelMeta,
      sheetToCSV: deps.sheetToCSV,
      parseGeoJSON: deps.parseGeoJSON,
      isGeoJSONObject: deps.isGeoJSONObject,
      extractParquetSchema: deps.extractParquetSchema,
      getFileInfo: deps.getFileInfo,
      getActiveSandboxRuntime: deps.getActiveSandboxRuntime,
    })
  );
}

/**
 * The materializer deps — assembled ONCE, the same wiring as the web
 * manifest-connect route (src/app/api/manifest/connect/route.ts). A drift here
 * is invisible until a cache stops hitting or an entity reads the wrong
 * source, which is exactly why both doors share this shape.
 */
function manifestMaterializeDeps(): MaterializeDeps {
  return {
    readCachedSchema: async (sourceKey, fingerprint) => {
      const entry = await readSchemaCache<CSVSchemaT>(sourceKey);
      return entry && entry.fingerprint === fingerprint ? entry.artifact : null;
    },
    writeCachedSchema: (sourceKey, fingerprint, schema) =>
      writeSchemaCache(sourceKey, fingerprint, schema),
    extractBatch: (targets, creds, budgetMs) =>
      extractRemoteParquetSchemaBatch(targets, creds, budgetMs),
    registerEntity: (csvId, schema, readUrl, creds, isHive) =>
      storeRemoteParquetRef(csvId, schema, readUrl, creds, isHive),
    newId: () => randomUUID(),
  };
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
    stopRun,
    runAskQuery,
    assembleSpecFromPatches,
    persistHistoryEntry,
    loadHistoryEntry,
    exportDashboardHtml,
    exportAppTemplateHtml,
    getCachedArtifacts,
    getActiveSandboxRuntime,
    getCSVContent,
    getStoredCSV,
    restoreStoredCSV,
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
    ingestFile,
    introspectWithCache,
    connectManifest: async ({ url, creds }) => {
      const { record } = await connectDatasetManifest(
        { url, ...(creds ? { creds } : {}) },
        {
          fetchManifestText,
          ...manifestMaterializeDeps(),
          eagerCapable: () => getActiveSandboxRuntime() === "docker",
          store: getManifestStore(),
          now: () => Date.now(),
        }
      );
      return record;
    },
    getManifestRecord: (manifestId) => getManifestStore().get(manifestId),
    // The selection pre-step (spec §7) — CODE-GEN tier, temperature 0, cost
    // tracked, and the deterministic keyword fallback on any model failure:
    // the same decisions as the web select route, because the pick decides
    // what the expensive step sees.
    selectManifestEntities: (record, question) =>
      trackRouteCost({ mode: "manifest-select", question }, async () => {
        let raw = "";
        try {
          const result = await generateText({
            model: getModel(getActiveModels().codeGen),
            prompt: buildSelectionPrompt(record, question),
            temperature: 0,
            maxOutputTokens: 200,
          });
          raw = result.text;
        } catch (err) {
          logger.warn("MCP manifest select: model call failed, using fallback", {
            error: errMessage(err),
          });
        }
        return parseSelection(raw, record, question);
      }),
    ensureManifestEntitiesReady: (record, names) =>
      ensureManifestEntities({
        record,
        names,
        deps: manifestMaterializeDeps(),
        budgetMs: MANIFEST_EAGER_BUDGET_MS,
        eagerCapable: getActiveSandboxRuntime() === "docker",
        // wasm fallback: the SAME single-entity extractor the url door uses,
        // so MCP manifests work on the built-in runtime (no Docker, no client).
        extractOne: (target, creds, csvId, filename) =>
          extractRemoteParquetSchema(
            target.readUrl,
            csvId,
            filename,
            getActiveSandboxRuntime(),
            target.isHivePartitioned,
            creds
          ),
      }),
    // Live getters, not a boot-time snapshot: the MCP server has no
    // localStorage, so the Settings UI's model choice reaches it through
    // runtime-config — and a long-lived server must see changes made after
    // it started.
    models: {
      get codeGen() {
        return getActiveModels().codeGen;
      },
      get uiCompose() {
        return getActiveModels().uiCompose;
      },
    },
  };
}

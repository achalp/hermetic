/**
 * Typed API client — centralizes all fetch calls.
 * Replaces raw fetch() scattered across components.
 */

import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";
import {
  connectRemoteParquet,
  type RemoteParquetCreds,
  type RemoteParquetResult,
} from "@/app/lib/remote-parquet-connect";
import type { HistoryMeta, SavedVizMeta } from "@/lib/contracts/storage-types";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type { WarehouseTableInfo, WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import type { TraceStep, NotebookLayout } from "@/lib/pipeline/investigation-trace";
import type { Spec } from "@/lib/contracts/spec";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { Exemplar } from "@/lib/contracts/learning";
import type { AuditResult } from "@/lib/pipeline/audit";

// ── Helpers ────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) {
    throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

// ── Providers ──────────────────────────────────────────────────

export interface ProviderInfo {
  active: string;
  activeLabel: string;
  configured: string[];
  model?: string;
  /** Whether the OS keychain is available for storing API keys. */
  keychain_available?: boolean;
}

export interface RuntimeStatus {
  id: string;
  label: string;
  available: boolean;
}

// ── /api/settings (runtime-config blocks + keychain API keys) ────────

export interface SettingsBlocks {
  providers: {
    openaiBaseUrl?: string | null;
    openaiModel?: string | null;
    vertexProject?: string | null;
    vertexLocation?: string | null;
    awsRegion?: string | null;
  };
  sandbox: {
    memoryFraction?: number | null;
  };
  retention: {
    maxHistoryEntries?: number | null;
    maxRunRecords?: number | null;
  };
}

export type ApiKeyId = "anthropic" | "openai";

export interface SettingsInfo {
  /** The runtime-config values (what the form edits). */
  config: SettingsBlocks;
  /** Resolved values (runtime-config → env) — shown as placeholders. */
  effective: SettingsBlocks;
  /** Key status only — key material never crosses this API. */
  api_keys: Record<ApiKeyId, { set: boolean; source: "keychain" | "env" | null }>;
  keychain_available: boolean;
}

export interface SettingsUpdate {
  providers?: Record<string, string>;
  sandbox?: Record<string, string | number>;
  retention?: Record<string, string | number>;
  /** Stored in the OS keychain; empty string deletes. */
  api_keys?: Partial<Record<ApiKeyId, string>>;
}

export async function getSettings(signal?: AbortSignal): Promise<SettingsInfo> {
  const res = await fetch("/api/settings", { signal });
  return json<SettingsInfo>(res);
}

export async function putSettings(update: SettingsUpdate): Promise<SettingsInfo> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  return json<SettingsInfo>(res);
}

export async function getProviders(signal?: AbortSignal): Promise<ProviderInfo> {
  const res = await fetch("/api/providers", { signal });
  return json<ProviderInfo>(res);
}

export async function getRuntimes(signal?: AbortSignal): Promise<RuntimeStatus[]> {
  const res = await fetch("/api/runtimes", { signal });
  return json<RuntimeStatus[]>(res);
}

/** Persist the server-side active sandbox runtime selection. Best-effort. */
export async function setActiveSandboxRuntime(sandboxRuntime: string): Promise<void> {
  const res = await fetch("/api/runtimes", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sandboxRuntime }),
  });
  // A non-OK write MUST reject — callers revert their optimistic mirror on
  // failure, and a resolved 4xx/5xx would leave the UI displaying a
  // selection that never persisted.
  if (!res.ok) throw new ApiError(`Failed to persist runtime (${res.status})`, res.status);
}

/** Persist the model selection server-side (runtime-config) so MCP and
 *  context-less requests honor the same choice. Best-effort. */
export async function setComposerMode(mode: "generative" | "compiled"): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ composer: { mode } }),
  });
  if (!res.ok) throw new ApiError(`Failed to persist composer mode (${res.status})`, res.status);
}

export async function setActiveModels(models: {
  codeGen?: string;
  uiCompose?: string;
  effort?: string;
  efforts?: Record<string, string>;
}): Promise<void> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  });
  if (!res.ok) throw new ApiError(`Failed to persist model selection (${res.status})`, res.status);
}

/** Switch the active LLM provider (Settings). */
export async function setActiveProvider(
  provider: string
): Promise<{ active: string; activeLabel: string }> {
  const res = await fetch("/api/providers", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
  });
  return json<{ active: string; activeLabel: string }>(res);
}

// ── Notebook lazy cell compose ─────────────────────────────

export interface ComposeCellStep {
  index: number;
  stepNo: number;
  question: string;
  rationale: string;
  results: Record<string, unknown>;
  chart_data: Record<string, unknown>;
  degraded: boolean;
  degradedReason?: string;
}

/** Compose notebook cells lazily on Notebook-open (investigate route). */
export async function composeNotebookCells(
  body: {
    original_question: string;
    approach?: string;
    csv_id?: string | null;
    steps: ComposeCellStep[];
  },
  signal?: AbortSignal
): Promise<Record<string, Spec>> {
  const res = await fetch("/api/query/investigate/compose-cell", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await json<{ cells?: Record<string, Spec> }>(res);
  return data.cells ?? {};
}

// ── Upload ─────────────────────────────────────────────────────

export interface UploadResult {
  csv_id?: string;
  schema?: CSVSchema;
  excel_id?: string;
  filename?: string;
  sheets?: SheetInfo[];
  relationships?: SheetRelationship[];
}

export async function uploadFile(formData: FormData): Promise<UploadResult> {
  const res = await fetch("/api/upload", { method: "POST", body: formData });
  return json<UploadResult>(res);
}

export interface SelectSheetResult {
  csv_id: string;
  schema: CSVSchema;
}

export async function selectSheet(excelId: string, sheetName: string): Promise<SelectSheetResult> {
  const res = await fetch("/api/upload/select-sheet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ excel_id: excelId, sheet_name: sheetName }),
  });
  return json<SelectSheetResult>(res);
}

export async function selectWorkbook(excelId: string): Promise<SelectSheetResult> {
  const res = await fetch("/api/upload/select-workbook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ excel_id: excelId }),
  });
  return json<SelectSheetResult>(res);
}

// ── Visualizations ─────────────────────────────────────────────

export async function listVizs(signal?: AbortSignal): Promise<SavedVizMeta[]> {
  const res = await fetch("/api/vizs", { signal });
  const data = await json<{ vizs: SavedVizMeta[] }>(res);
  return data.vizs;
}

export interface LoadedVizWorkbook {
  filename: string;
  sheetInfo: SheetInfo[];
  relationships: SheetRelationship[];
}

export interface LoadedViz {
  meta: SavedVizMeta;
  spec: Spec;
  csvId: string;
  schema: CSVSchema;
  artifacts?: CachedArtifacts;
  workbook?: LoadedVizWorkbook;
}

export async function loadViz(vizId: string): Promise<LoadedViz> {
  const res = await fetch(`/api/vizs/${vizId}`);
  return json<LoadedViz>(res);
}

export async function deleteViz(vizId: string): Promise<void> {
  const res = await fetch(`/api/vizs/${vizId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Delete failed", res.status);
  }
}

export interface SaveVizResult {
  meta: SavedVizMeta;
}

export async function saveViz(
  csvId: string,
  spec: unknown,
  question: string,
  parentVizId?: string,
  historyId?: string | null
): Promise<SaveVizResult> {
  const res = await fetch("/api/vizs/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvId, spec, question, parentVizId, historyId: historyId ?? undefined }),
  });
  return json<SaveVizResult>(res);
}

// ── Rerun ───────────────────────────────────────────────────────

export interface RerunResult {
  schemaMatch: boolean;
  spec?: Spec;
  artifacts?: CachedArtifacts;
  meta?: SavedVizMeta;
  csvId: string;
  schema: CSVSchema;
  question?: string;
}

export async function rerunViz(vizId: string, file: File): Promise<RerunResult> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`/api/vizs/${vizId}/rerun`, {
    method: "POST",
    body: formData,
  });
  return json<RerunResult>(res);
}

// ── Refresh (re-run without LLM) ─────────────────────────────

export interface RefreshResult {
  spec: Spec;
  artifacts: CachedArtifacts;
  csvId: string;
  schema: CSVSchema;
  historyId: string;
  executionMs: number;
}

export async function refreshViz(
  vizId: string,
  warehouseId?: string | null
): Promise<RefreshResult> {
  const res = await fetch(`/api/vizs/${vizId}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouseId: warehouseId ?? undefined }),
  });
  return json<RefreshResult>(res);
}

// ── Artifacts ──────────────────────────────────────────────────

export async function getArtifacts(csvId: string): Promise<CachedArtifacts> {
  const res = await fetch(`/api/artifacts/${csvId}`);
  return json<CachedArtifacts>(res);
}

// ── Suggestions (schema + follow-up) ──────────────────────────

export interface SuggestionRequest {
  schema?: unknown;
  warehouseSchema?: unknown;
}

export interface FollowUpSuggestionRequest extends SuggestionRequest {
  question: string;
  resultsSummary?: Record<string, unknown>;
  specSummary?: string[];
}

export async function getSuggestions(
  body: SuggestionRequest,
  signal?: AbortSignal
): Promise<string[]> {
  const res = await fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const data = await json<{ questions: string[] }>(res);
  return data.questions ?? [];
}

export async function getFollowUpSuggestions(
  body: FollowUpSuggestionRequest,
  signal?: AbortSignal
): Promise<string[]> {
  const res = await fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, mode: "follow-up" }),
    signal,
  });
  const data = await json<{ questions: string[] }>(res);
  return data.questions ?? [];
}

// ── Local Backend Config ──────────────────────────────────────

export interface LocalBackendConfig {
  ollama?: {
    enabled: boolean;
    activeModel?: string;
  };
  mlx?: {
    enabled: boolean;
    activeModel?: string;
  };
  llamaCpp?: {
    enabled: boolean;
    activeModel?: string;
  };
}

export async function getLocalBackendConfig(signal?: AbortSignal): Promise<LocalBackendConfig> {
  const res = await fetch("/api/local-llm/config", { signal });
  return json<LocalBackendConfig>(res);
}

/** @deprecated Use getLocalBackendConfig instead */
export async function getOllamaConfig(signal?: AbortSignal): Promise<LocalBackendConfig> {
  return getLocalBackendConfig(signal);
}

// ── LLM Readiness Check ──────────────────────────────────────

export interface LlmReadiness {
  ready: boolean;
  provider: string;
  message?: string;
}

const LOCAL_PROVIDERS = ["ollama", "mlx", "llama-cpp"];

/**
 * Check if the active LLM provider is ready to accept queries.
 * For local providers, checks both that the server is running and healthy.
 */
export async function checkLlmReady(): Promise<LlmReadiness> {
  const provider = await getProviders().catch(() => null);
  if (!provider) {
    return {
      ready: false,
      provider: "unknown",
      message: "No LLM provider configured. Open Settings to choose one.",
    };
  }

  if (!LOCAL_PROVIDERS.includes(provider.active)) {
    // Cloud providers are assumed ready if configured
    return { ready: true, provider: provider.active };
  }

  // For local providers, check the backend status
  const backend = provider.active === "llama-cpp" ? "llama-cpp" : provider.active;
  try {
    const res = await fetch(`/api/local-llm/status?backend=${backend}`);
    const status = await res.json();
    if (status.status === "ready") {
      return { ready: true, provider: provider.active };
    }
    return {
      ready: false,
      provider: provider.active,
      message: `Local LLM server (${provider.activeLabel}) is not running. Start it in Settings.`,
    };
  } catch {
    return {
      ready: false,
      provider: provider.active,
      message: `Local LLM server (${provider.activeLabel}) is not running. Start it in Settings.`,
    };
  }
}

// ── Analysis History ──────────────────────────────────────────

export async function listHistory(signal?: AbortSignal): Promise<HistoryMeta[]> {
  const res = await fetch("/api/history", { signal });
  const data = await json<{ entries: HistoryMeta[] }>(res);
  return data.entries;
}

/** Per-analysis cost rows (raw CSV columns as strings), newest first. */
export async function getCostRows(signal?: AbortSignal): Promise<Record<string, string>[]> {
  const res = await fetch("/api/cost", { signal });
  const data = await json<{ rows: Record<string, string>[] }>(res);
  return data.rows ?? [];
}

/** Per-run diagnostics records (newest first, capped server-side at 500). */
export async function getDiagnosticsRuns<T>(signal?: AbortSignal): Promise<T[]> {
  const res = await fetch("/api/diagnostics?limit=500", { signal });
  const data = await json<{ runs?: T[] }>(res);
  return data.runs ?? [];
}

/** The learning loop's review state (ledger, proposals, exemplar count). */
export async function getLearningState<T>(signal?: AbortSignal): Promise<T> {
  const res = await fetch("/api/learning", { signal });
  return json<T>(res);
}

/** Approve or reject a graduated lesson proposal. */

export interface LoadedHistory {
  meta: HistoryMeta;
  spec: Spec;
  artifacts?: Record<string, unknown>;
  schema: CSVSchema;
  csvId?: string;
}

export async function loadHistoryEntry(id: string): Promise<LoadedHistory> {
  const res = await fetch(`/api/history/${id}`);
  return json<LoadedHistory>(res);
}

export async function refreshHistoryEntry(
  historyId: string,
  warehouseId?: string | null
): Promise<RefreshResult> {
  const res = await fetch(`/api/history/${historyId}/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouseId: warehouseId ?? undefined }),
  });
  return json<RefreshResult>(res);
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Delete failed", res.status);
  }
}

export async function saveHistoryEntry(
  csvId: string,
  spec: unknown,
  question: string
): Promise<{ meta?: HistoryMeta; skipped?: boolean }> {
  const res = await fetch("/api/history/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvId, spec, question }),
  });
  return json<{ meta?: HistoryMeta; skipped?: boolean }>(res);
}

// ── Local File Browser ────────────────────────────────────────

export interface LocalFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  mtime?: number;
  extension?: string;
  isParquetFolder?: boolean;
  isHivePartitioned?: boolean;
}

export interface BrowseResult {
  path: string;
  entries: LocalFileEntry[];
}

export async function browseLocalFiles(path?: string): Promise<BrowseResult> {
  const params = path ? `?path=${encodeURIComponent(path)}` : "";
  const res = await fetch(`/api/local-files/browse${params}`);
  return json<BrowseResult>(res);
}

export interface LocalFileSelection {
  path: string;
  name: string;
  size: number;
  mtime: number;
  extension: string;
  isDirectory: boolean;
  isParquetFolder: boolean;
  isHivePartitioned?: boolean;
  info?: string;
}

export async function selectLocalFile(
  path: string,
  type: "file" | "folder"
): Promise<LocalFileSelection> {
  const res = await fetch("/api/local-files/select", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, type }),
  });
  return json<LocalFileSelection>(res);
}

export interface LocalSchemaResult {
  csv_id?: string;
  schema?: CSVSchema;
  excel_id?: string;
  filename?: string;
  sheets?: SheetInfo[];
  relationships?: SheetRelationship[];
}

export async function extractLocalSchema(
  path: string,
  type: "file" | "folder"
): Promise<LocalSchemaResult> {
  const res = await fetch("/api/local-files/schema", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, type }),
  });
  return json<LocalSchemaResult>(res);
}

/** Optional S3 credentials for a private cloud Parquet source (anon by default). */
// Both shapes are owned by the connect module (it is what sends and reads them);
// re-exported here so existing importers of the typed client are unaffected.
export type { RemoteParquetCreds, RemoteParquetResult } from "@/app/lib/remote-parquet-connect";

/**
 * Register a remote cloud Parquet URL (s3:// or https://) that DuckDB reads
 * directly — no download. Returns the extracted schema. Anonymous unless `creds`
 * are supplied.
 */
export async function extractRemoteParquetSchema(
  url: string,
  creds?: RemoteParquetCreds,
  /** "Ignore cache / re-read schema" — bypass the schema cache and overwrite it. */
  force?: boolean
): Promise<RemoteParquetResult> {
  // On the built-in (wasm) runtime this is a TWO-HOP flow — the server hands back
  // a job the browser runs in its worker — so the protocol lives in its own module
  // rather than in this per-endpoint client (build log D27/D29).
  return connectRemoteParquet({ url, creds, force }, json);
}

// ── Active runs (reconnect to an analysis that survived a client drop) ──

export interface ActiveRun {
  runId: string;
  csvId?: string;
  question?: string;
  route: string;
  startedAt: number;
}

/** Analyses still running server-side (survive reload/HMR — see run-stream-hub). */
export async function getActiveRuns(): Promise<ActiveRun[]> {
  try {
    const res = await fetch("/api/query/active");
    const data = await json<{ runs: ActiveRun[] }>(res);
    return data.runs ?? [];
  } catch {
    return [];
  }
}

// ── Dashboard plan editing (compiled composer) ────────────────────────

/** The edit surface /api/plan GET returns (see lib/compose/edit.ts). */
export interface PlanEditSurface {
  doc: import("@/lib/contracts/plan").PlanDocument;
  sections: {
    id: string;
    kind: "banner" | "tiles" | "node" | "view" | "controls";
    op?: string;
    label: string;
    preview?: string;
    hidden: boolean;
    width: "half" | "full";
  }[];
  claims: {
    name: string;
    dtype: string;
    cited: boolean;
    suggestedOp: string;
    preview: string;
  }[];
  views: { id: string; kind: string; seriesId: string; reason: string; shipped: boolean }[];
}

export async function getPlanSurface(
  csvId: string,
  historyId?: string | null,
  signal?: AbortSignal
): Promise<PlanEditSurface | null> {
  const hid = historyId ? `&history_id=${encodeURIComponent(historyId)}` : "";
  const res = await fetch(`/api/plan?csv_id=${encodeURIComponent(csvId)}${hid}`, { signal });
  // null means "this dashboard has no plan" (not compiled) — a FAILED
  // request must throw instead: conflating the two made a transient 500
  // render as "switch to the compiled composer" on a compiled dashboard.
  if (!res.ok) throw new ApiError(`Failed to load plan (${res.status})`, res.status);
  const data = (await res.json()) as { surface?: PlanEditSurface | null };
  return data.surface ?? null;
}

export async function patchPlan(
  csvId: string,
  mutations: import("@/lib/contracts/plan").PlanMutation[],
  historyId?: string | null
): Promise<{ spec: Spec; plan: import("@/lib/contracts/plan").PlanDocument }> {
  const res = await fetch("/api/plan", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv_id: csvId, mutations, history_id: historyId ?? undefined }),
  });
  return json<{ spec: Spec; plan: import("@/lib/contracts/plan").PlanDocument }>(res);
}

/** Fetch the stored schema for a csvId (to restore a source on reattach). */
export async function getSchemaByCsvId(
  csvId: string
): Promise<{ csv_id: string; schema: CSVSchema } | null> {
  try {
    const res = await fetch(`/api/sources/schema?csvId=${encodeURIComponent(csvId)}`);
    if (!res.ok) return null;
    return await json<{ csv_id: string; schema: CSVSchema }>(res);
  } catch {
    return null;
  }
}

// ── Recent sources (uploads / local / cloud) ─────────────────

export interface RecentSourceInfo {
  id: string;
  kind: "upload" | "local-file" | "local-folder" | "remote-parquet";
  name: string;
  subtitle: string;
  rows?: number;
  url?: string;
  creds?: RemoteParquetCreds;
  path?: string;
  isHivePartitioned?: boolean;
  lastUsedAt: string;
  useCount: number;
}

export async function getRecentSources(): Promise<RecentSourceInfo[]> {
  try {
    const res = await fetch("/api/sources/recent");
    const data = await json<{ sources: RecentSourceInfo[] }>(res);
    return data.sources ?? [];
  } catch {
    return [];
  }
}

export async function renameRecentSource(id: string, name: string): Promise<void> {
  await fetch("/api/sources/recent", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
}

export async function removeRecentSource(id: string): Promise<void> {
  await fetch("/api/sources/recent", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function clearRecentSources(): Promise<void> {
  await fetch("/api/sources/recent", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ all: true }),
  });
}

// ── Warehouse ────────────────────────────────────────────────

export interface ConnectWarehouseResult {
  warehouse_id: string;
  warehouse_type: string;
  tables: WarehouseTableInfo[];
  table_schemas: WarehouseTableSchema[];
  table_count: number;
  total_columns: number;
}

/**
 * Stop an in-flight analysis on demand (the cancel button). Best-effort — a
 * finished run is a no-op. Fire-and-forget: the streaming request unwinds on
 * its own once the server aborts it.
 */
export async function stopAnalysis(runId: string): Promise<void> {
  await fetch("/api/query/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId }),
  }).catch(() => {});
}

export async function connectWarehouse(
  config: WarehouseConnectionConfig,
  /** "Ignore cache / re-read schema" — bypass the schema cache and overwrite it. */
  force?: boolean
): Promise<ConnectWarehouseResult> {
  const res = await fetch("/api/warehouse/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(force ? { ...config, force: true } : config),
  });
  return json<ConnectWarehouseResult>(res);
}

export async function disconnectWarehouse(warehouseId: string): Promise<void> {
  await fetch("/api/warehouse/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: warehouseId }),
  });
}

export interface WarehouseSampleResult {
  headers: string[];
  rows: string[][];
}

export async function getWarehouseSample(
  warehouseId: string,
  tableName: string
): Promise<WarehouseSampleResult> {
  const res = await fetch(
    `/api/warehouse/sample?warehouse_id=${encodeURIComponent(warehouseId)}&table=${encodeURIComponent(tableName)}`
  );
  return json<WarehouseSampleResult>(res);
}

// ── Scheduled re-runs ──────────────────────────────────────

export type ScheduleCadence =
  "hourly" | "daily-9am" | "daily-eod" | "weekly-monday" | "on-file-change";

export interface ScheduleEntry {
  vizId: string;
  cadence: ScheduleCadence;
  autoExport: ("xlsx" | "csv")[];
  createdAt: number;
  lastRunAt: number | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  nextRunAt: number | null;
}

export async function listSchedules(signal?: AbortSignal): Promise<ScheduleEntry[]> {
  const res = await fetch("/api/vizs/schedule", { signal });
  const data = await json<{ schedules: ScheduleEntry[] }>(res);
  return data.schedules ?? [];
}

export async function setSchedule(
  vizId: string,
  cadence: ScheduleCadence,
  autoExport: ("xlsx" | "csv")[]
): Promise<ScheduleEntry> {
  const res = await fetch("/api/vizs/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vizId, cadence, autoExport }),
  });
  const data = await json<{ ok: true; schedule: ScheduleEntry }>(res);
  return data.schedule;
}

export async function deleteSchedule(vizId: string): Promise<void> {
  const res = await fetch("/api/vizs/schedule", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vizId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Failed to delete schedule", res.status);
  }
}

export async function runScheduleNow(vizId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/vizs/schedule/run-now", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vizId }),
  });
  return json<{ ok: boolean; error?: string }>(res);
}

// ── Edit-and-rerun ─────────────────────────────────────────

export interface RerunArtifactsResult {
  ok: true;
  artifacts: CachedArtifacts;
}

export async function rerunCode(csvId: string, code: string): Promise<RerunArtifactsResult> {
  const res = await fetch("/api/query/rerun", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv_id: csvId, code }),
  });
  return json<RerunArtifactsResult>(res);
}

export interface RerunStepResult {
  ok: true;
  step: TraceStep;
  /** 0-based indices of steps that transitively depend on the re-run step. */
  dependents: number[];
}

/** Re-run one investigation step's code (notebook mode). */
export async function rerunInvestigateStep(args: {
  csvId: string;
  stepIndex: number;
  code?: string;
}): Promise<RerunStepResult> {
  const res = await fetch("/api/query/investigate/rerun-step", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      csv_id: args.csvId,
      step_index: args.stepIndex,
      code: args.code,
    }),
  });
  return json<RerunStepResult>(res);
}

/** Recompose the dashboard spec from the (re-run) investigation trail. */
export async function recomposeInvestigation(csvId: string): Promise<{ ok: true; spec: Spec }> {
  const res = await fetch("/api/query/investigate/recompose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv_id: csvId }),
  });
  return json<{ ok: true; spec: Spec }>(res);
}

/** Persist the user-authored notebook layout (markdown cells + ordering). */
export async function saveNotebookLayout(
  csvId: string,
  layout: NotebookLayout
): Promise<{ ok: true }> {
  const res = await fetch("/api/query/investigate/notebook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csv_id: csvId, layout }),
  });
  return json<{ ok: true }>(res);
}

// ── dbt metadata ────────────────────────────────────────────

export interface DbtBindingResult {
  ok: true;
  manifestPath: string;
  enrichedTableCount: number;
  totalTableCount: number;
}

export async function bindDbtManifest(
  warehouseId: string,
  manifestPath: string
): Promise<DbtBindingResult> {
  const res = await fetch("/api/warehouse/dbt-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: warehouseId, manifestPath }),
  });
  return json<DbtBindingResult>(res);
}

export async function unbindDbtManifest(warehouseId: string): Promise<void> {
  const res = await fetch("/api/warehouse/dbt-metadata", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: warehouseId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Failed to clear dbt manifest", res.status);
  }
}

export interface SavedConnectionInfo {
  id: string;
  label: string;
  /** Optional user-entered friendly name; display falls back to `label`. */
  name?: string;
  config: WarehouseConnectionConfig;
  createdAt: string;
}

export async function getSavedConnections(signal?: AbortSignal): Promise<SavedConnectionInfo[]> {
  const res = await fetch("/api/warehouse/presets", { signal });
  const data = await json<{ connections: SavedConnectionInfo[] }>(res);
  return data.connections;
}

export async function deleteSavedConnection(id: string): Promise<void> {
  const res = await fetch("/api/warehouse/presets", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Delete failed", res.status);
  }
}

/** Set the friendly name of a saved connection (empty clears to auto label). */
export async function renameSavedConnection(id: string, name: string): Promise<void> {
  const res = await fetch("/api/warehouse/presets", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Rename failed", res.status);
  }
}

// ── Local LLM backends (Settings) ──────────────────────────────

export interface LocalLlmStatus {
  running: boolean;
  status?: string;
  version?: string;
  baseUrl?: string;
  activeModel?: string;
  pid?: number;
  managed?: boolean;
  systemRamGb?: number;
  logs?: string[];
  downloads?: Array<{ model: string; progress: number; status: string }>;
}

export interface LocalBackendModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface LlmfitModel {
  name: string;
  provider: string;
  score: number;
  best_quant: string;
  fit_level: string;
  memory_required_gb: number;
  estimated_tps: number;
  parameter_count: string;
  use_case: string;
  category: string;
  context_length: number;
  gguf_sources: Array<{ provider: string; repo: string }>;
}

export async function getLocalLlmStatus(
  backend: string,
  signal?: AbortSignal
): Promise<LocalLlmStatus> {
  const res = await fetch(`/api/local-llm/status?backend=${encodeURIComponent(backend)}`, {
    signal,
  });
  return json<LocalLlmStatus>(res);
}

export async function getLocalLlmModels(
  backend: string
): Promise<{ models?: LocalBackendModel[] }> {
  const res = await fetch(`/api/local-llm/models?backend=${encodeURIComponent(backend)}`);
  return json<{ models?: LocalBackendModel[] }>(res);
}

export async function getLocalLlmRecommendations(
  backend: string,
  limit: number
): Promise<{ models?: LlmfitModel[] }> {
  const res = await fetch(
    `/api/local-llm/recommend?backend=${encodeURIComponent(backend)}&limit=${limit}`
  );
  return json<{ models?: LlmfitModel[] }>(res);
}

export async function getLocalLlmPlatform(
  signal?: AbortSignal
): Promise<{ os: string; arch: string }> {
  const res = await fetch("/api/local-llm/platform", { signal });
  return json<{ os: string; arch: string }>(res);
}

export async function putLocalLlmConfig(config: {
  backend: string;
  enabled: boolean;
  activeModel: string;
}): Promise<void> {
  const res = await fetch("/api/local-llm/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Failed to save config", res.status);
  }
}

export async function startLocalLlmServer(
  body: { backend: string; model: string },
  signal?: AbortSignal
): Promise<unknown> {
  const res = await fetch("/api/local-llm/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return json<unknown>(res);
}

/** Best-effort: the caller deactivates + re-polls regardless of outcome. */
export async function stopLocalLlmServer(backend: string): Promise<void> {
  await fetch("/api/local-llm/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backend }),
  });
}

/** Returns the raw Response: the body is an NDJSON progress stream. */
export async function downloadLocalLlmModel(body: {
  backend: string;
  model: string;
}): Promise<Response> {
  const res = await fetch("/api/local-llm/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError("Failed to start download", res.status);
  return res;
}

export async function deleteLocalLlmModel(body: { backend: string; model: string }): Promise<void> {
  const res = await fetch("/api/local-llm/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "Failed to delete model", res.status);
  }
}

// ── Interactive HTML export (single-file dashboard) ───────────

export interface HtmlExportResult {
  blob: Blob;
  /** Server-derived download name (from the question). */
  filename: string;
  /** Which renderer bundle got inlined — size honesty (dashboard-distribution spec §5). */
  bundle: string;
  bytes: number;
}

/**
 * Compile the current spec into the self-contained interactive HTML file.
 * The spec is sent AS-IS (including `__`-prefixed internal state) — the
 * assembler strips internals server-side, so the client never needs to know
 * the private-namespace convention.
 */
export async function exportInteractiveHtml(
  spec: unknown,
  question: string | null
): Promise<HtmlExportResult> {
  const res = await fetch("/api/export-html", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      spec,
      question: question ?? undefined,
      // A live dashboard's as-of watermark is "now" (persisted entries get
      // their stored timestamp via the CLI/MCP surfaces instead).
      created_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? "HTML export failed", res.status);
  }
  const filename =
    res.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "dashboard.html";
  return {
    blob: await res.blob(),
    filename,
    bundle: res.headers.get("X-Hermetic-Export-Bundle") ?? "standard",
    bytes: Number(res.headers.get("X-Hermetic-Export-Bytes") ?? 0),
  };
}

// ── Static assets ──────────────────────────────────────────────

/** Fetch a same-origin static asset (e.g. the bundled sample dataset). */
export async function fetchStaticAsset(path: string): Promise<Blob> {
  const res = await fetch(path);
  if (!res.ok) throw new ApiError(`Failed to fetch ${path}`, res.status);
  return res.blob();
}

// ── Learning exemplars ─────────────────────────────────────────

/** GET /api/learning — verified exemplars; tolerant (empty list on failure). */
export async function getLearningExemplars(signal?: AbortSignal): Promise<Exemplar[]> {
  const res = await fetch("/api/learning", { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { exemplars?: Exemplar[] };
  return data.exemplars ?? [];
}

/** DELETE /api/learning?exemplar=<id> — remove one exemplar (fire-and-forget). */
export async function deleteLearningExemplar(id: string): Promise<void> {
  await fetch(`/api/learning?exemplar=${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Audit ──────────────────────────────────────────────────────

/** GET /api/audit — the persisted audit for a run; tolerant (null on failure). */
export async function getAudit(
  historyId: string,
  signal?: AbortSignal
): Promise<AuditResult | null> {
  const res = await fetch(`/api/audit?history_id=${encodeURIComponent(historyId)}`, { signal });
  if (!res.ok) return null;
  const data = (await res.json()) as { audit?: AuditResult | null };
  return data.audit ?? null;
}

/** POST /api/audit — run the blind audit for a run; throws with the error text. */
export async function runAudit(historyId: string): Promise<AuditResult> {
  const res = await fetch("/api/audit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ history_id: historyId }),
  });
  const data = (await res.json()) as { audit?: AuditResult; error?: string };
  if (!res.ok || !data.audit) throw new Error(data.error ?? "Audit failed");
  return data.audit;
}

// ── Model settings (raw view for the settings drawer) ──────────

/**
 * The settings-drawer view of /api/settings — the model/effort/runtime/composer
 * fields the drawer mirrors, which are richer than SettingsInfo's typed blocks.
 * Tolerant (null on non-ok) to match the drawer's snap-back-on-failure behavior.
 */
export interface ModelSettingsView {
  config?: {
    models?: { effort?: string; efforts?: Record<string, string> };
    composer?: { mode?: string };
  };
  effective?: {
    models?: { codeGen?: string; uiCompose?: string };
    sandbox?: { runtime?: string };
  };
}

export async function getModelSettings(signal?: AbortSignal): Promise<ModelSettingsView | null> {
  const res = await fetch("/api/settings", { signal });
  return res.ok ? ((await res.json()) as ModelSettingsView) : null;
}

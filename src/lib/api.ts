/**
 * Typed API client — centralizes all fetch calls.
 * Replaces raw fetch() scattered across components.
 */

import type { CSVSchema, SavedVizMeta, SheetInfo, SheetRelationship } from "@/lib/types";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";

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
}

export interface RuntimeStatus {
  id: string;
  label: string;
  available: boolean;
}

export async function getProviders(signal?: AbortSignal): Promise<ProviderInfo> {
  const res = await fetch("/api/providers", { signal });
  return json<ProviderInfo>(res);
}

export async function getRuntimes(signal?: AbortSignal): Promise<RuntimeStatus[]> {
  const res = await fetch("/api/runtimes", { signal });
  return json<RuntimeStatus[]>(res);
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
  spec: Record<string, unknown>;
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
  parentVizId?: string
): Promise<SaveVizResult> {
  const res = await fetch("/api/vizs/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvId, spec, question, parentVizId }),
  });
  return json<SaveVizResult>(res);
}

// ── Rerun ───────────────────────────────────────────────────────

export interface RerunResult {
  schemaMatch: boolean;
  spec?: Record<string, unknown>;
  artifacts?: CachedArtifacts;
  meta?: SavedVizMeta;
  csvId: string;
  schema: CSVSchema;
  question?: string;
}

export async function rerunViz(
  vizId: string,
  file: File,
  sandboxRuntime?: string
): Promise<RerunResult> {
  const formData = new FormData();
  formData.append("file", file);
  if (sandboxRuntime) formData.append("sandbox_runtime", sandboxRuntime);

  const res = await fetch(`/api/vizs/${vizId}/rerun`, {
    method: "POST",
    body: formData,
  });
  return json<RerunResult>(res);
}

// ── Artifacts ──────────────────────────────────────────────────

export async function getArtifacts(csvId: string): Promise<CachedArtifacts> {
  const res = await fetch(`/api/artifacts/${csvId}`);
  return json<CachedArtifacts>(res);
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

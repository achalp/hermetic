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

export async function getProviders(): Promise<ProviderInfo> {
  const res = await fetch("/api/providers");
  return json<ProviderInfo>(res);
}

export async function getRuntimes(): Promise<RuntimeStatus[]> {
  const res = await fetch("/api/runtimes");
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

export async function listVizs(): Promise<SavedVizMeta[]> {
  const res = await fetch("/api/vizs");
  const data = await json<{ vizs: SavedVizMeta[] }>(res);
  return data.vizs;
}

export interface LoadedViz {
  meta: SavedVizMeta;
  spec: Record<string, unknown>;
  csvContent: string;
  artifacts?: CachedArtifacts;
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
  question: string
): Promise<SaveVizResult> {
  const res = await fetch("/api/vizs/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ csvId, spec, question }),
  });
  return json<SaveVizResult>(res);
}

// ── Artifacts ──────────────────────────────────────────────────

export async function getArtifacts(csvId: string): Promise<CachedArtifacts> {
  const res = await fetch(`/api/artifacts/${csvId}`);
  return json<CachedArtifacts>(res);
}

// ── Ollama ─────────────────────────────────────────────────────

export interface OllamaConfig {
  ollama?: {
    enabled: boolean;
    activeModel?: string;
  };
}

export async function getOllamaConfig(): Promise<OllamaConfig> {
  const res = await fetch("/api/ollama/config");
  return json<OllamaConfig>(res);
}

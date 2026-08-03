import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import type { SavedVizMeta } from "@/lib/contracts/storage-types";
import type { SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import { hermeticPaths } from "@/lib/paths";
import { RecordDirStore, RECORD_FILES } from "@/lib/record-store";
import { HERMETIC_SPEC_VERSION } from "@/lib/contracts/spec";

/** Persisted workbook data — all sheets' CSV content + UI metadata */
export interface SavedWorkbook {
  filename: string;
  sheets: { name: string; csvContent: string }[];
  sheetInfo: SheetInfo[];
  relationships: SheetRelationship[];
}

const store = new RecordDirStore(hermeticPaths.savedVizsDir());

export interface SaveInput {
  question: string;
  csvFilename: string;
  csvContent: string;
  generatedCode: string;
  spec: Record<string, unknown>;
  artifacts?: CachedArtifacts;
  schemaFingerprint?: string;
  workbook?: SavedWorkbook;
  sourceType?: "upload" | "local" | "warehouse";
  localPath?: string;
  sql?: string;
}

export async function saveVisualization(input: SaveInput): Promise<SavedVizMeta> {
  const vizId = uuidv4();
  const now = Date.now();

  const meta: SavedVizMeta = {
    vizId,
    question: input.question,
    csvFilename: input.csvFilename,
    createdAt: now,
    versionCount: 1,
    latestVersionTs: now,
    schemaFingerprint: input.schemaFingerprint,
    sourceType: input.sourceType,
    localPath: input.localPath,
    sql: input.sql,
  };

  const files: Record<string, string> = {
    [RECORD_FILES.meta]: JSON.stringify(meta, null, 2),
    [RECORD_FILES.spec]: JSON.stringify(
      { ...input.spec, hermeticSpecVersion: HERMETIC_SPEC_VERSION },
      null,
      2
    ),
    [RECORD_FILES.code]: input.generatedCode,
    [RECORD_FILES.source]: input.csvContent,
  };
  if (input.artifacts) files[RECORD_FILES.artifacts] = JSON.stringify(input.artifacts);
  if (input.workbook) files[RECORD_FILES.workbook] = JSON.stringify(input.workbook);
  await store.writeFiles(vizId, files);

  return meta;
}

export interface SaveVersionInput {
  csvFilename: string;
  csvContent: string;
  generatedCode: string;
  spec: Record<string, unknown>;
  artifacts?: CachedArtifacts;
  schemaFingerprint: string;
  sourceType?: "upload" | "local" | "warehouse";
  localPath?: string;
  sql?: string;
}

/**
 * Move current root files into history/{oldTimestamp}/, write new files at root,
 * and update meta.json with incremented versionCount and new latestVersionTs.
 */
export async function saveNewVersion(
  vizId: string,
  input: SaveVersionInput
): Promise<SavedVizMeta> {
  const meta = await store.readRequiredJson<SavedVizMeta>(vizId, RECORD_FILES.meta);

  const oldTimestamp = meta.latestVersionTs ?? meta.createdAt;
  // Archive every record file except meta.json (which is updated in place) —
  // derived from THE layout, so a new record file can't be silently dropped
  // from versioning again.
  const filesToArchive = Object.values(RECORD_FILES).filter((f) => f !== RECORD_FILES.meta);
  await store.archiveFiles(vizId, filesToArchive, join("history", String(oldTimestamp)));

  const now = Date.now();
  const updatedMeta: SavedVizMeta = {
    ...meta,
    csvFilename: input.csvFilename,
    versionCount: (meta.versionCount ?? 1) + 1,
    latestVersionTs: now,
    schemaFingerprint: input.schemaFingerprint,
    // Preserve or update source info for refresh
    sourceType: input.sourceType ?? meta.sourceType,
    localPath: input.localPath ?? meta.localPath,
    sql: input.sql ?? meta.sql,
  };

  const files: Record<string, string> = {
    [RECORD_FILES.meta]: JSON.stringify(updatedMeta, null, 2),
    [RECORD_FILES.spec]: JSON.stringify(
      { ...input.spec, hermeticSpecVersion: HERMETIC_SPEC_VERSION },
      null,
      2
    ),
    [RECORD_FILES.code]: input.generatedCode,
    [RECORD_FILES.source]: input.csvContent,
  };
  if (input.artifacts) files[RECORD_FILES.artifacts] = JSON.stringify(input.artifacts);
  await store.writeFiles(vizId, files);

  return updatedMeta;
}

export async function listSavedVisualizations(): Promise<SavedVizMeta[]> {
  const metas = await store.listMetas<SavedVizMeta>();
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

interface LoadedVisualization {
  meta: SavedVizMeta;
  spec: Record<string, unknown>;
  generatedCode: string;
  csvContent: string;
  artifacts?: CachedArtifacts;
  workbook?: SavedWorkbook;
}

export async function loadSavedVisualization(id: string): Promise<LoadedVisualization> {
  const [meta, spec, generatedCode, csvContent, artifacts, workbook] = await Promise.all([
    store.readRequiredJson<SavedVizMeta>(id, RECORD_FILES.meta),
    store.readRequiredJson<Record<string, unknown>>(id, RECORD_FILES.spec),
    store.readRequiredText(id, RECORD_FILES.code),
    store.readRequiredText(id, RECORD_FILES.source),
    store.readOptionalJson<CachedArtifacts>(id, RECORD_FILES.artifacts),
    store.readOptionalJson<SavedWorkbook>(id, RECORD_FILES.workbook),
  ]);
  return { meta, spec, generatedCode, csvContent, artifacts, workbook };
}

export async function deleteSavedVisualization(id: string): Promise<void> {
  await store.delete(id);
}

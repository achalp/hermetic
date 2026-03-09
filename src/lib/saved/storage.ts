import { mkdir, writeFile, readFile, readdir, rm, rename, stat } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import type { SavedVizMeta, SheetInfo, SheetRelationship } from "@/lib/types";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";

/** Persisted workbook data — all sheets' CSV content + UI metadata */
export interface SavedWorkbook {
  filename: string;
  sheets: { name: string; csvContent: string }[];
  sheetInfo: SheetInfo[];
  relationships: SheetRelationship[];
}

const SAVED_DIR = join(process.cwd(), "data", "saved-vizs");

let dirCreated = false;
async function ensureDir(subdir?: string) {
  const dir = subdir ? join(SAVED_DIR, subdir) : SAVED_DIR;
  if (!dirCreated) {
    await mkdir(SAVED_DIR, { recursive: true });
    dirCreated = true;
  }
  if (subdir) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

export interface SaveInput {
  question: string;
  csvFilename: string;
  csvContent: string;
  generatedCode: string;
  spec: Record<string, unknown>;
  artifacts?: CachedArtifacts;
  schemaFingerprint?: string;
  workbook?: SavedWorkbook;
}

export async function saveVisualization(input: SaveInput): Promise<SavedVizMeta> {
  const vizId = uuidv4();
  const dir = await ensureDir(vizId);
  const now = Date.now();

  const meta: SavedVizMeta = {
    vizId,
    question: input.question,
    csvFilename: input.csvFilename,
    createdAt: now,
    versionCount: 1,
    latestVersionTs: now,
    schemaFingerprint: input.schemaFingerprint,
  };

  const writes = [
    writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8"),
    writeFile(join(dir, "spec.json"), JSON.stringify(input.spec, null, 2), "utf-8"),
    writeFile(join(dir, "code.py"), input.generatedCode, "utf-8"),
    writeFile(join(dir, "source.csv"), input.csvContent, "utf-8"),
  ];
  if (input.artifacts) {
    writes.push(writeFile(join(dir, "artifacts.json"), JSON.stringify(input.artifacts), "utf-8"));
  }
  if (input.workbook) {
    writes.push(writeFile(join(dir, "workbook.json"), JSON.stringify(input.workbook), "utf-8"));
  }
  await Promise.all(writes);

  return meta;
}

export interface SaveVersionInput {
  csvFilename: string;
  csvContent: string;
  generatedCode: string;
  spec: Record<string, unknown>;
  artifacts?: CachedArtifacts;
  schemaFingerprint: string;
}

/**
 * Move current root files into history/{oldTimestamp}/, write new files at root,
 * and update meta.json with incremented versionCount and new latestVersionTs.
 */
export async function saveNewVersion(
  vizId: string,
  input: SaveVersionInput
): Promise<SavedVizMeta> {
  const dir = join(SAVED_DIR, vizId);
  const metaRaw = await readFile(join(dir, "meta.json"), "utf-8");
  const meta: SavedVizMeta = JSON.parse(metaRaw);

  const oldTimestamp = meta.latestVersionTs ?? meta.createdAt;
  const historyDir = join(dir, "history", String(oldTimestamp));
  await mkdir(historyDir, { recursive: true });

  // Move current root files to history (best-effort — skip if missing)
  const filesToArchive = ["spec.json", "code.py", "source.csv", "artifacts.json"];
  await Promise.all(
    filesToArchive.map(async (f) => {
      try {
        await stat(join(dir, f));
        await rename(join(dir, f), join(historyDir, f));
      } catch {
        // File may not exist (e.g. artifacts.json on older vizs)
      }
    })
  );

  const now = Date.now();
  const updatedMeta: SavedVizMeta = {
    ...meta,
    csvFilename: input.csvFilename,
    versionCount: (meta.versionCount ?? 1) + 1,
    latestVersionTs: now,
    schemaFingerprint: input.schemaFingerprint,
  };

  const writes = [
    writeFile(join(dir, "meta.json"), JSON.stringify(updatedMeta, null, 2), "utf-8"),
    writeFile(join(dir, "spec.json"), JSON.stringify(input.spec, null, 2), "utf-8"),
    writeFile(join(dir, "code.py"), input.generatedCode, "utf-8"),
    writeFile(join(dir, "source.csv"), input.csvContent, "utf-8"),
  ];
  if (input.artifacts) {
    writes.push(writeFile(join(dir, "artifacts.json"), JSON.stringify(input.artifacts), "utf-8"));
  }
  await Promise.all(writes);

  return updatedMeta;
}

export async function listSavedVisualizations(): Promise<SavedVizMeta[]> {
  try {
    await ensureDir();
    const entries = await readdir(SAVED_DIR, { withFileTypes: true });
    const metas: SavedVizMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(join(SAVED_DIR, entry.name, "meta.json"), "utf-8");
        metas.push(JSON.parse(raw));
      } catch {
        // Skip corrupted entries
      }
    }

    return metas.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
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
  const dir = join(SAVED_DIR, id);
  const [metaRaw, specRaw, code, csv] = await Promise.all([
    readFile(join(dir, "meta.json"), "utf-8"),
    readFile(join(dir, "spec.json"), "utf-8"),
    readFile(join(dir, "code.py"), "utf-8"),
    readFile(join(dir, "source.csv"), "utf-8"),
  ]);

  let artifacts: CachedArtifacts | undefined;
  try {
    const artifactsRaw = await readFile(join(dir, "artifacts.json"), "utf-8");
    artifacts = JSON.parse(artifactsRaw);
  } catch {
    // artifacts.json may not exist for older saved vizs
  }

  let workbook: SavedWorkbook | undefined;
  try {
    const workbookRaw = await readFile(join(dir, "workbook.json"), "utf-8");
    workbook = JSON.parse(workbookRaw);
  } catch {
    // workbook.json only exists for workbook-mode vizs
  }

  return {
    meta: JSON.parse(metaRaw),
    spec: JSON.parse(specRaw),
    generatedCode: code,
    csvContent: csv,
    artifacts,
    workbook,
  };
}

export async function deleteSavedVisualization(id: string): Promise<void> {
  // Validate id is a UUID to prevent path traversal
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid visualization ID");
  }
  const dir = join(SAVED_DIR, id);
  await rm(dir, { recursive: true, force: true });
}

import { mkdir, writeFile, readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import type { SavedVizMeta } from "@/lib/types";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";

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

interface SaveInput {
  question: string;
  csvFilename: string;
  csvContent: string;
  generatedCode: string;
  spec: Record<string, unknown>;
  artifacts?: CachedArtifacts;
}

export async function saveVisualization(input: SaveInput): Promise<SavedVizMeta> {
  const vizId = uuidv4();
  const dir = await ensureDir(vizId);

  const meta: SavedVizMeta = {
    vizId,
    question: input.question,
    csvFilename: input.csvFilename,
    createdAt: Date.now(),
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
  await Promise.all(writes);

  return meta;
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

  return {
    meta: JSON.parse(metaRaw),
    spec: JSON.parse(specRaw),
    generatedCode: code,
    csvContent: csv,
    artifacts,
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

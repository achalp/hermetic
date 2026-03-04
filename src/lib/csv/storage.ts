import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { CSVSchema, StoredCSV, WorkbookManifest } from "@/lib/types";
import { CSV_TTL_MS } from "@/lib/constants";

// Use globalThis to persist across module reloads in dev mode
const globalStore = globalThis as unknown as {
  __csvStore?: Map<string, StoredCSV>;
  __workbookManifestStore?: Map<string, WorkbookManifest>;
};
if (!globalStore.__csvStore) {
  globalStore.__csvStore = new Map();
}
if (!globalStore.__workbookManifestStore) {
  globalStore.__workbookManifestStore = new Map();
}
const store = globalStore.__csvStore;
const manifestStore = globalStore.__workbookManifestStore;

const CSV_DIR = join(tmpdir(), "hermetic");

let dirCreated = false;
async function ensureDir() {
  if (!dirCreated) {
    await mkdir(CSV_DIR, { recursive: true });
    dirCreated = true;
  }
}

export async function storeCSV(csvId: string, csvText: string, schema: CSVSchema): Promise<void> {
  await ensureDir();
  const filePath = join(CSV_DIR, `${csvId}.csv`);
  await writeFile(filePath, csvText, "utf-8");
  store.set(csvId, { schema, filePath, createdAt: Date.now() });
}

export function getStoredCSV(csvId: string): StoredCSV | undefined {
  const entry = store.get(csvId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CSV_TTL_MS) {
    store.delete(csvId);
    unlink(entry.filePath).catch(() => {});
    // Also clean up sidecar GeoJSON file if present
    unlink(join(CSV_DIR, `${csvId}.geojson`)).catch(() => {});
    return undefined;
  }
  return entry;
}

export async function getCSVContent(csvId: string): Promise<string | null> {
  const entry = getStoredCSV(csvId);
  if (!entry) return null;
  try {
    return await readFile(entry.filePath, "utf-8");
  } catch {
    store.delete(csvId);
    return null;
  }
}

export async function storeGeoJSON(csvId: string, geojsonText: string): Promise<void> {
  await ensureDir();
  const filePath = join(CSV_DIR, `${csvId}.geojson`);
  await writeFile(filePath, geojsonText, "utf-8");
}

export async function getGeoJSONContent(csvId: string): Promise<string | null> {
  try {
    return await readFile(join(CSV_DIR, `${csvId}.geojson`), "utf-8");
  } catch {
    return null;
  }
}

export function storeWorkbookManifest(primaryCsvId: string, manifest: WorkbookManifest): void {
  manifestStore.set(primaryCsvId, manifest);
}

export function getWorkbookManifest(primaryCsvId: string): WorkbookManifest | undefined {
  return manifestStore.get(primaryCsvId);
}

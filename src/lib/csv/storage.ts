import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { CSVSchema, WorkbookManifest } from "@/lib/contracts/data-schema";
import type { StoredCSV, RemoteCreds } from "@/lib/contracts/storage-types";
import { CSV_TTL_MS } from "@/lib/constants";
import { isIdleExpired, touch } from "@/lib/store-ttl";
import { hermeticPaths } from "@/lib/paths";
import { stateNamespace } from "@/lib/state-store";

// Process-lifetime state via the shared StateStore (survives dev reloads).
const store = stateNamespace<StoredCSV>("csv");
const manifestStore = stateNamespace<WorkbookManifest>("workbook-manifests");

const CSV_DIR = hermeticPaths.scratchDir();

let dirCreated = false;
async function ensureDir() {
  if (!dirCreated) {
    await mkdir(CSV_DIR, { recursive: true });
    dirCreated = true;
  }
}

/** Local files live on disk and are bind-mounted — they never expire. */
function isLocalEntry(entry: StoredCSV): boolean {
  return !!(entry.localPath || entry.localFolderPath);
}

/**
 * Whether `entry` should be evicted at `now`. Local (bind-mounted) files never
 * expire; everything else follows the shared sliding-idle + active-run-pin
 * policy (see lib/store-ttl.ts).
 */
function isExpired(entry: StoredCSV, now: number): boolean {
  if (isLocalEntry(entry)) return false;
  return isIdleExpired(entry, entry.createdAt, CSV_TTL_MS, now);
}

/**
 * Active sweep for the store-sweeper (see lib/store-sweeper.ts). Expiry was
 * previously lazy-only (checked inside getStoredCSV), so entries never read
 * again lived forever, and a server restart emptied the index while the
 * on-disk files under tmpdir/hermetic accumulated as orphans.
 */
export async function sweepExpiredCSVStore(): Promise<{ expired: number; orphans: number }> {
  const now = Date.now();
  let expired = 0;
  for (const [csvId, entry] of store) {
    if (isExpired(entry, now)) {
      store.delete(csvId);
      manifestStore.delete(csvId);
      unlink(entry.filePath).catch(() => {});
      unlink(join(CSV_DIR, `${csvId}.geojson`)).catch(() => {});
      expired++;
    }
  }
  // Orphaned files: on disk but not in the index (e.g. written before a
  // restart). Age-gated by mtime so an in-flight write is never touched.
  let orphans = 0;
  try {
    const { readdir, stat } = await import("fs/promises");
    for (const name of await readdir(CSV_DIR)) {
      const id = name.replace(/\.(csv|geojson)$/, "");
      if (store.has(id)) continue;
      const full = join(CSV_DIR, name);
      const info = await stat(full).catch(() => null);
      if (info && now - info.mtimeMs > CSV_TTL_MS) {
        await unlink(full).catch(() => {});
        orphans++;
      }
    }
  } catch {
    // dir may not exist yet
  }
  return { expired, orphans };
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
  const now = Date.now();
  if (isExpired(entry, now)) {
    store.delete(csvId);
    unlink(entry.filePath).catch(() => {});
    // Also clean up sidecar GeoJSON file if present
    unlink(join(CSV_DIR, `${csvId}.geojson`)).catch(() => {});
    return undefined;
  }
  // Slide the idle window forward and pin to the reading run (if any).
  touch(entry, now);
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

/**
 * Store a reference to a local file (no content copy).
 * Used for local file browser selections where data is bind-mounted.
 */
export function storeLocalFileRef(
  csvId: string,
  schema: CSVSchema,
  localPath: string,
  mtime: number,
  isFolder: boolean,
  isHivePartitioned?: boolean
): void {
  store.set(csvId, {
    schema,
    filePath: "", // no temp file — data accessed via bind-mount
    createdAt: Date.now(),
    localPath: isFolder ? undefined : localPath,
    localFolderPath: isFolder ? localPath : undefined,
    localMtime: mtime,
    isParquet: true,
    isHivePartitioned,
  });
}

/**
 * Register a REMOTE cloud Parquet source (s3:// or https:// URL that DuckDB reads
 * directly — no download, no bind-mount). `url` must be pre-validated.
 */
export function storeRemoteParquetRef(
  csvId: string,
  schema: CSVSchema,
  url: string,
  creds?: RemoteCreds,
  isHivePartitioned?: boolean
): void {
  store.set(csvId, {
    schema,
    filePath: "",
    createdAt: Date.now(),
    isParquet: true,
    isHivePartitioned,
    remoteParquetUrl: url,
    remoteCreds: creds,
  });
}

/**
 * Check if a stored entry is a local file reference (bind-mounted).
 */
export function isLocalFile(csvId: string): boolean {
  const entry = store.get(csvId);
  return !!entry && !!(entry.localPath || entry.localFolderPath);
}

/** Check if a stored entry is a remote cloud Parquet source. */
export function isRemoteFile(csvId: string): boolean {
  return !!store.get(csvId)?.remoteParquetUrl;
}

/**
 * Get the local host path for a stored local file entry.
 * Returns the file path or folder path.
 */
export function getLocalFilePath(csvId: string): string | undefined {
  const entry = store.get(csvId);
  if (!entry) return undefined;
  return entry.localPath || entry.localFolderPath;
}

export function storeWorkbookManifest(primaryCsvId: string, manifest: WorkbookManifest): void {
  manifestStore.set(primaryCsvId, manifest);
}

export function getWorkbookManifest(primaryCsvId: string): WorkbookManifest | undefined {
  return manifestStore.get(primaryCsvId);
}

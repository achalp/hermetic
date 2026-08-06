import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import type { CSVSchema, WorkbookManifest } from "@/lib/contracts/data-schema";
import type { StoredCSV, RemoteCreds } from "@/lib/contracts/storage-types";
import { touch, registerSweepable } from "@/lib/store-ttl";
import { hermeticPaths } from "@/lib/paths";
import { stateNamespace } from "@/lib/state-store";

// Process-lifetime state via the shared StateStore (survives dev reloads).
const store = stateNamespace<StoredCSV>("csv");
const manifestStore = stateNamespace<WorkbookManifest>("workbook-manifests");

// Resolved per call, not at import — a module-level const froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const csvDir = () => hermeticPaths.scratchDir();

// Memoized on the resolved path (not a boolean) so a root change re-creates.
let createdDir: string | null = null;
async function ensureDir(): Promise<string> {
  const dir = csvDir();
  if (createdDir !== dir) {
    await mkdir(dir, { recursive: true });
    createdDir = dir;
  }
  return dir;
}

/**
 * Retention policy (2026-08-05): entries NEVER idle-expire. This is a local,
 * single-user tool — the index entry is a few hundred bytes (schema + a file
 * path; the bytes live on disk in scratch), so the old 3h sliding-idle
 * eviction saved almost nothing while costing the worst UX in the product:
 * "CSV not found or expired. Please re-upload." after any three-hour gap.
 * Remote-parquet refs were even cheaper to keep (a URL + creds + schema —
 * the data lives in the bucket). Warehouse connections still idle out
 * (lib/warehouse/storage.ts): those hold credentialed sockets.
 *
 * What remains swept: ORPHAN scratch files (written before a restart — the
 * in-memory index dies with the process), age-gated generously.
 */
const ORPHAN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Active sweep for the store-sweeper (see lib/store-sweeper.ts). Expiry was
 * previously lazy-only (checked inside getStoredCSV), so entries never read
 * again lived forever, and a server restart emptied the index while the
 * on-disk files under tmpdir/hermetic accumulated as orphans.
 */
export async function sweepExpiredCSVStore(): Promise<{ expired: number; orphans: number }> {
  const now = Date.now();
  // Index entries are retained for the life of the process (see policy above).
  const expired = 0;
  // Orphaned files: on disk but not in the index (written before a restart).
  // Age-gated by mtime so an in-flight write is never touched.
  let orphans = 0;
  try {
    const { readdir, stat } = await import("fs/promises");
    for (const name of await readdir(csvDir())) {
      const id = name.replace(/\.(csv|geojson)$/, "");
      if (store.has(id)) continue;
      const full = join(csvDir(), name);
      const info = await stat(full).catch(() => null);
      if (info && now - info.mtimeMs > ORPHAN_AGE_MS) {
        await unlink(full).catch(() => {});
        orphans++;
      }
    }
  } catch {
    // dir may not exist yet
  }
  return { expired, orphans };
}

// Registration-at-definition: the sweeper iterates the registry, so this store
// cannot be silently missing from a central roll call.
registerSweepable("csv", async () => {
  const { expired, orphans } = await sweepExpiredCSVStore();
  return { csvExpired: expired, csvOrphans: orphans };
});

/**
 * `local` attaches the on-disk origin (bind-mount execution + TTL exemption)
 * AT store time — callers used to patch localPath onto the returned entry
 * after the fact, which left the ref invisible to this module's invariants.
 */
export async function storeCSV(
  csvId: string,
  csvText: string,
  schema: CSVSchema,
  local?: { path: string; mtime: number }
): Promise<void> {
  await ensureDir();
  const filePath = join(csvDir(), `${csvId}.csv`);
  await writeFile(filePath, csvText, "utf-8");
  store.set(csvId, {
    schema,
    filePath,
    createdAt: Date.now(),
    localPath: local?.path,
    localMtime: local?.mtime,
  });
}

export function getStoredCSV(csvId: string): StoredCSV | undefined {
  const entry = store.get(csvId);
  if (!entry) return undefined;
  // Touch retained for run-pinning diagnostics; entries no longer expire.
  touch(entry, Date.now());
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
  const filePath = join(csvDir(), `${csvId}.geojson`);
  await writeFile(filePath, geojsonText, "utf-8");
}

export async function getGeoJSONContent(csvId: string): Promise<string | null> {
  try {
    return await readFile(join(csvDir(), `${csvId}.geojson`), "utf-8");
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

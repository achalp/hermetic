import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { registerSweepable } from "@/lib/store-ttl";
import { hermeticPaths } from "@/lib/paths";
import { stateNamespace } from "@/lib/state-store";

interface StoredExcel {
  filePath: string;
  filename: string;
  createdAt: number;
}

const store = stateNamespace<StoredExcel>("excel");

// Resolved per call, not at import — a module-level const froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const excelDir = () => hermeticPaths.excelTempDir();

// Memoized on the resolved path (not a boolean) so a root change re-creates.
let createdDir: string | null = null;
async function ensureDir(): Promise<string> {
  const dir = excelDir();
  if (createdDir !== dir) {
    await mkdir(dir, { recursive: true });
    createdDir = dir;
  }
  return dir;
}

export async function storeExcel(excelId: string, buffer: Buffer, filename: string): Promise<void> {
  const dir = await ensureDir();
  const filePath = join(dir, `${excelId}.xlsx`);
  await writeFile(filePath, buffer);
  store.set(excelId, { filePath, filename, createdAt: Date.now() });
}

export function getStoredExcel(excelId: string): StoredExcel | undefined {
  // Retention policy 2026-08-05 (see lib/csv/storage.ts): workbook entries no
  // longer idle-expire — a sheet picker left open over lunch must still work.
  return store.get(excelId);
}

export async function getExcelBuffer(excelId: string): Promise<Buffer | null> {
  const entry = getStoredExcel(excelId);
  if (!entry) return null;
  try {
    return await readFile(entry.filePath);
  } catch {
    store.delete(excelId);
    return null;
  }
}

export async function deleteStoredExcel(excelId: string): Promise<void> {
  const entry = store.get(excelId);
  if (entry) {
    await unlink(entry.filePath).catch(() => {});
    store.delete(excelId);
  }
}

/** Active sweep (see lib/store-sweeper.ts) — retention keeps index entries
 * for the process lifetime; only week-old files are reclaimed (their entry,
 * if any, dies with them — post-restart orphans have none). */
const ORPHAN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export function sweepExpiredExcel(): number {
  const now = Date.now();
  let swept = 0;
  for (const [k, v] of store) {
    if (now - v.createdAt > ORPHAN_AGE_MS) {
      store.delete(k);
      unlink(v.filePath).catch(() => {});
      swept++;
    }
  }
  return swept;
}

// Registration-at-definition: the sweeper iterates the registry, so this store
// cannot be silently missing from a central roll call.
registerSweepable("excel", sweepExpiredExcel);

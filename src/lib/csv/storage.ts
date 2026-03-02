import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { CSVSchema, StoredCSV } from "@/lib/types";
import { CSV_TTL_MS } from "@/lib/constants";

// Use globalThis to persist across module reloads in dev mode
const globalStore = globalThis as unknown as {
  __csvStore?: Map<string, StoredCSV>;
};
if (!globalStore.__csvStore) {
  globalStore.__csvStore = new Map();
}
const store = globalStore.__csvStore;

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

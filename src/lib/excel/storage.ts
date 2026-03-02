import { writeFile, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { CSV_TTL_MS } from "@/lib/constants";

interface StoredExcel {
  filePath: string;
  filename: string;
  createdAt: number;
}

const globalStore = globalThis as unknown as {
  __excelStore?: Map<string, StoredExcel>;
};
if (!globalStore.__excelStore) {
  globalStore.__excelStore = new Map();
}
const store = globalStore.__excelStore;

const EXCEL_DIR = join(tmpdir(), "csv-insight", "excel-temp");

let dirCreated = false;
async function ensureDir() {
  if (!dirCreated) {
    await mkdir(EXCEL_DIR, { recursive: true });
    dirCreated = true;
  }
}

export async function storeExcel(
  excelId: string,
  buffer: Buffer,
  filename: string
): Promise<void> {
  await ensureDir();
  const filePath = join(EXCEL_DIR, `${excelId}.xlsx`);
  await writeFile(filePath, buffer);
  store.set(excelId, { filePath, filename, createdAt: Date.now() });
}

export function getStoredExcel(excelId: string): StoredExcel | undefined {
  const entry = store.get(excelId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > CSV_TTL_MS) {
    store.delete(excelId);
    unlink(entry.filePath).catch(() => {});
    return undefined;
  }
  return entry;
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

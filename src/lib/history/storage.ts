import "server-only";
import { mkdir, writeFile, readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import type { HistoryMeta } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseType } from "@/lib/contracts/connection-configs";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import { summarizeSpec, extractDescription } from "@/lib/spec-summary";

const HISTORY_DIR = join(process.cwd(), "data", "history");

/**
 * Cap on persisted history entries (API-9). Every run writes
 * meta/spec/code/schema/artifacts (+ source.csv for uploads) — unbounded,
 * that's unbounded disk growth. History only grows via saves, so
 * prune-on-save (oldest beyond the cap) fully bounds data/history/ without
 * a background job. Override with HERMETIC_MAX_HISTORY_ENTRIES.
 */
const DEFAULT_MAX_HISTORY_ENTRIES = 200;

function maxHistoryEntries(): number {
  const raw = Number(process.env.HERMETIC_MAX_HISTORY_ENTRIES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_HISTORY_ENTRIES;
}

let dirCreated = false;
async function ensureDir(subdir?: string) {
  const dir = subdir ? join(HISTORY_DIR, subdir) : HISTORY_DIR;
  if (!dirCreated) {
    await mkdir(HISTORY_DIR, { recursive: true });
    dirCreated = true;
  }
  if (subdir) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

// ── Chart type extraction ─────────────────────────────────────

interface SpecElement {
  type: string;
  children?: string[];
}

const LAYOUT_TYPES = new Set([
  "LayoutRow",
  "LayoutColumn",
  "LayoutGrid",
  "LayoutTabs",
  "LayoutAccordion",
  "LayoutStack",
]);

/**
 * Walk the spec tree and collect unique non-layout component types.
 */
export function extractChartTypes(spec: Record<string, unknown>): string[] {
  const elements = spec.elements as Record<string, SpecElement> | undefined;
  const root = spec.root as string | undefined;
  if (!elements || !root) return [];

  const types = new Set<string>();
  const visit = (key: string) => {
    const el = elements[key];
    if (!el) return;
    if (!LAYOUT_TYPES.has(el.type)) {
      types.add(el.type);
    }
    if (el.children) {
      for (const child of el.children) visit(child);
    }
  };
  visit(root);
  return Array.from(types);
}

// ── Save input ────────────────────────────────────────────────

export interface HistorySaveInput {
  question: string;
  spec: Record<string, unknown>;
  generatedCode: string;
  schema: CSVSchema;
  artifacts?: CachedArtifacts;
  sourceFile: string;
  sourceType: "upload" | "local" | "warehouse";
  localPath?: string;
  warehouseType?: WarehouseType;
  csvContent?: string; // only for uploaded files
  executionMs: number;
  /** Dataset id this run ran under — enables the artifacts cache-miss fallback. */
  csvId?: string;
}

// ── CRUD ──────────────────────────────────────────────────────

export async function saveHistoryEntry(input: HistorySaveInput): Promise<HistoryMeta> {
  const id = uuidv4();
  const dir = await ensureDir(id);
  const now = Date.now();

  const meta: HistoryMeta = {
    id,
    question: input.question,
    timestamp: now,
    csvId: input.csvId,
    sourceFile: input.sourceFile,
    sourceType: input.sourceType,
    localPath: input.localPath,
    warehouseType: input.warehouseType,
    rowCount: input.schema.row_count,
    columnCount: input.schema.columns.length,
    chartTypes: extractChartTypes(input.spec),
    executionMs: input.executionMs,
    specSummary: summarizeSpec(input.spec),
    description: extractDescription(input.spec),
  };

  const writes = [
    writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8"),
    writeFile(join(dir, "spec.json"), JSON.stringify(input.spec, null, 2), "utf-8"),
    writeFile(join(dir, "code.py"), input.generatedCode, "utf-8"),
    writeFile(join(dir, "schema.json"), JSON.stringify(input.schema, null, 2), "utf-8"),
  ];

  if (input.artifacts) {
    writes.push(writeFile(join(dir, "artifacts.json"), JSON.stringify(input.artifacts), "utf-8"));
  }

  // Only store CSV content for uploaded files (local files are on disk, warehouse data is in artifacts)
  if (input.csvContent && input.sourceType === "upload") {
    writes.push(writeFile(join(dir, "source.csv"), input.csvContent, "utf-8"));
  }

  await Promise.all(writes);

  // Cap enforcement — best-effort: a prune failure must not fail the save
  // that triggered it (the new entry is already on disk at this point).
  try {
    await pruneHistory();
  } catch {
    // ignore
  }

  return meta;
}

/**
 * Delete the oldest entries beyond `max`, newest kept. Returns the number
 * pruned. Per-entry deletion is best-effort — one stuck directory must not
 * strand the rest.
 */
export async function pruneHistory(max = maxHistoryEntries()): Promise<number> {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const metas = await listHistory(); // newest-first
  let pruned = 0;
  for (const victim of metas.slice(max)) {
    try {
      await deleteHistoryEntry(victim.id);
      pruned++;
    } catch {
      // best-effort
    }
  }
  return pruned;
}

export async function listHistory(): Promise<HistoryMeta[]> {
  try {
    await ensureDir();
    const entries = await readdir(HISTORY_DIR, { withFileTypes: true });
    const metas: HistoryMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const raw = await readFile(join(HISTORY_DIR, entry.name, "meta.json"), "utf-8");
        metas.push(JSON.parse(raw));
      } catch {
        // Skip corrupted entries
      }
    }

    return metas.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

export interface LoadedHistoryEntry {
  meta: HistoryMeta;
  spec: Record<string, unknown>;
  generatedCode: string;
  schema: CSVSchema;
  artifacts?: CachedArtifacts;
  csvContent?: string;
}

export async function loadHistoryEntry(id: string): Promise<LoadedHistoryEntry> {
  validateId(id);
  const dir = join(HISTORY_DIR, id);

  const [metaRaw, specRaw, code, schemaRaw] = await Promise.all([
    readFile(join(dir, "meta.json"), "utf-8"),
    readFile(join(dir, "spec.json"), "utf-8"),
    readFile(join(dir, "code.py"), "utf-8"),
    readFile(join(dir, "schema.json"), "utf-8"),
  ]);

  let artifacts: CachedArtifacts | undefined;
  try {
    const raw = await readFile(join(dir, "artifacts.json"), "utf-8");
    artifacts = JSON.parse(raw);
  } catch {
    // May not exist
  }

  let csvContent: string | undefined;
  try {
    csvContent = await readFile(join(dir, "source.csv"), "utf-8");
  } catch {
    // Only exists for uploaded files
  }

  return {
    meta: JSON.parse(metaRaw),
    spec: JSON.parse(specRaw),
    generatedCode: code,
    schema: JSON.parse(schemaRaw),
    artifacts,
    csvContent,
  };
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  validateId(id);
  await rm(join(HISTORY_DIR, id), { recursive: true, force: true });
}

/**
 * Find the most recent history entry that ran under `csvId`. Used to recover a
 * run's artifacts/trail when the in-memory artifacts cache has expired — the
 * data is persisted on disk, just under a different (UUID) key. Returns null
 * when nothing matches (e.g. entries saved before `csvId` was tracked).
 */
export async function findHistoryIdByCsvId(csvId: string): Promise<string | null> {
  if (!csvId) return null;
  const metas = await listHistory(); // newest-first
  const hit = metas.find((m) => m.csvId === csvId);
  return hit?.id ?? null;
}

/**
 * Load the persisted artifacts (incl. the investigation trail) for the most
 * recent run under `csvId`. The artifacts-cache fallback path. Best-effort.
 */
export async function loadArtifactsByCsvId(csvId: string): Promise<CachedArtifacts | undefined> {
  const id = await findHistoryIdByCsvId(csvId);
  if (!id) return undefined;
  try {
    const raw = await readFile(join(HISTORY_DIR, id, "artifacts.json"), "utf-8");
    return JSON.parse(raw) as CachedArtifacts;
  } catch {
    return undefined;
  }
}

/**
 * Overwrite the persisted artifacts.json for the most recent run under `csvId`.
 * Used to durably persist lazily-composed notebook cell specs back onto the
 * trail so a reopened notebook doesn't have to recompose them. Best-effort:
 * a missing entry is a no-op (returns false).
 */
export async function updateArtifactsByCsvId(
  csvId: string,
  artifacts: CachedArtifacts
): Promise<boolean> {
  const id = await findHistoryIdByCsvId(csvId);
  if (!id) return false;
  try {
    await writeFile(join(HISTORY_DIR, id, "artifacts.json"), JSON.stringify(artifacts), "utf-8");
    return true;
  } catch {
    return false;
  }
}

function validateId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Invalid history entry ID");
  }
}

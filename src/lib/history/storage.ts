import { v4 as uuidv4 } from "uuid";
import type { HistoryMeta } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseType } from "@/lib/contracts/connection-configs";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import { summarizeSpec, extractDescription } from "@/lib/spec-summary";
import { envConfig } from "@/lib/harness-slot";
import { hermeticPaths } from "@/lib/paths";
import { RecordDirStore, RECORD_FILES } from "@/lib/record-store";
import { HERMETIC_SPEC_VERSION } from "@/lib/contracts/spec";
import { validateSpec } from "@/lib/catalog";
import { logger } from "@/lib/logger";

const store = new RecordDirStore(hermeticPaths.historyDir());

/**
 * Cap on persisted history entries (API-9). Every run writes
 * meta/spec/code/schema/artifacts (+ source.csv for uploads) — unbounded,
 * that's unbounded disk growth. History only grows via saves, so
 * prune-on-save (oldest beyond the cap) fully bounds data/history/ without
 * a background job. Override with HERMETIC_MAX_HISTORY_ENTRIES.
 */
const DEFAULT_MAX_HISTORY_ENTRIES = 200;

function maxHistoryEntries(): number {
  const raw = Number(envConfig().HERMETIC_MAX_HISTORY_ENTRIES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_HISTORY_ENTRIES;
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

  // Warn-only spec validation (WS2): surfaces composer regressions in logs
  // without ever blocking a save the user is depending on.
  const check = validateSpec(input.spec);
  if (!check.success) {
    logger.warn("Persisting spec that fails catalog validation", {
      id,
      error: check.error?.slice(0, 300),
    });
  }

  const files: Record<string, string> = {
    [RECORD_FILES.meta]: JSON.stringify(meta, null, 2),
    [RECORD_FILES.spec]: JSON.stringify(
      { ...input.spec, hermeticSpecVersion: HERMETIC_SPEC_VERSION },
      null,
      2
    ),
    [RECORD_FILES.code]: input.generatedCode,
    [RECORD_FILES.schema]: JSON.stringify(input.schema, null, 2),
  };
  if (input.artifacts) files[RECORD_FILES.artifacts] = JSON.stringify(input.artifacts);
  // Only store CSV content for uploaded files (local files are on disk, warehouse data is in artifacts)
  if (input.csvContent && input.sourceType === "upload") {
    files[RECORD_FILES.source] = input.csvContent;
  }
  await store.writeFiles(id, files);

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
  const metas = await store.listMetas<HistoryMeta>();
  return metas.sort((a, b) => b.timestamp - a.timestamp);
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
  const [meta, spec, generatedCode, schema, artifacts, csvContent] = await Promise.all([
    store.readRequiredJson<HistoryMeta>(id, RECORD_FILES.meta),
    store.readRequiredJson<Record<string, unknown>>(id, RECORD_FILES.spec),
    store.readRequiredText(id, RECORD_FILES.code),
    store.readRequiredJson<CSVSchema>(id, RECORD_FILES.schema),
    store.readOptionalJson<CachedArtifacts>(id, RECORD_FILES.artifacts),
    store.readOptionalText(id, RECORD_FILES.source),
  ]);
  return { meta, spec, generatedCode, schema, artifacts, csvContent };
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  await store.delete(id);
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
  return store.readOptionalJson<CachedArtifacts>(id, RECORD_FILES.artifacts);
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
    await store.writeFiles(id, { [RECORD_FILES.artifacts]: JSON.stringify(artifacts) });
    return true;
  } catch {
    return false;
  }
}

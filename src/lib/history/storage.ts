import { v4 as uuidv4 } from "uuid";
import type { HistoryMeta, PersistedAudit } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseType } from "@/lib/contracts/connection-configs";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import { summarizeSpec, extractDescription } from "@/lib/spec-summary";
import { envConfig } from "@/lib/harness-slot";
import { hermeticPaths } from "@/lib/paths";
import { RecordDirStore, RECORD_FILES, RecordCorruptError } from "@/lib/record-store";
import { HERMETIC_SPEC_VERSION } from "@/lib/contracts/spec";
import { validateSpec } from "@/lib/catalog";
import { logger } from "@/lib/logger";
import { maxHistoryEntries as maxHistoryEntriesSetting } from "@/lib/settings";

// Constructed lazily and rebuilt on a root change — a module-scope
// `new RecordDirStore(...)` froze the pre-boot default root before the harness
// could call setPathRoots (the seam in lib/paths.ts).
let store_: RecordDirStore | undefined;
let storeRoot: string | undefined;
function store(): RecordDirStore {
  const root = hermeticPaths.historyDir();
  if (!store_ || storeRoot !== root) {
    store_ = new RecordDirStore(root);
    storeRoot = root;
  }
  return store_;
}

/**
 * Cap on persisted history entries (API-9). Every run writes
 * meta/spec/code/schema/artifacts (+ source.csv for uploads) — unbounded,
 * that's unbounded disk growth. History only grows via saves, so
 * prune-on-save (oldest beyond the cap) fully bounds data/history/ without
 * a background job. Override with HERMETIC_MAX_HISTORY_ENTRIES.
 */
const DEFAULT_MAX_HISTORY_ENTRIES = 200;

function maxHistoryEntries(): number {
  return maxHistoryEntriesSetting(DEFAULT_MAX_HISTORY_ENTRIES);
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
  /** Remote cloud-Parquet URL (rehydrated on restore — see HistoryMeta). */
  remoteParquetUrl?: string;
  isHivePartitioned?: boolean;
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
    remoteParquetUrl: input.remoteParquetUrl,
    isHivePartitioned: input.isHivePartitioned,
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
  await store().writeFiles(id, files);

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
  const metas = await store().listMetas<HistoryMeta>();
  return metas.sort((a, b) => b.timestamp - a.timestamp);
}

export interface LoadedHistoryEntry {
  meta: HistoryMeta;
  spec: Record<string, unknown>;
  generatedCode: string;
  schema: CSVSchema;
  artifacts?: CachedArtifacts;
  csvContent?: string;
  /** Persisted non-blind audit verdict, when one was run for this entry. */
  audit?: PersistedAudit;
}

export async function loadHistoryEntry(id: string): Promise<LoadedHistoryEntry> {
  try {
    const [meta, spec, generatedCode, schema, artifacts, csvContent, audit] = await Promise.all([
      store().readRequiredJson<HistoryMeta>(id, RECORD_FILES.meta),
      store().readRequiredJson<Record<string, unknown>>(id, RECORD_FILES.spec),
      store().readRequiredText(id, RECORD_FILES.code),
      store().readRequiredJson<CSVSchema>(id, RECORD_FILES.schema),
      store().readOptionalJson<CachedArtifacts>(id, RECORD_FILES.artifacts),
      store().readOptionalText(id, RECORD_FILES.source),
      store().readOptionalJson<PersistedAudit>(id, RECORD_FILES.audit),
    ]);
    return { meta, spec, generatedCode, schema, artifacts, csvContent, audit };
  } catch (err) {
    // Corrupt ≠ missing: a RecordCorruptError means the entry EXISTS but a
    // required file is unreadable/unparsable — surface which file and why,
    // so a broken record isn't diagnosed as "entry not found".
    if (err instanceof RecordCorruptError) {
      logger.warn("History entry is corrupt (not missing)", {
        id: err.recordId,
        file: err.file,
        reason: err.reason,
      });
    }
    throw err;
  }
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  await store().delete(id);
}

/** Persist the non-blind audit verdict as part of the entry's record —
 *  through the store, never a raw side-file write (a file the record
 *  contract doesn't know about is invisible to every load/export path). */
export async function saveHistoryAudit(id: string, audit: PersistedAudit): Promise<void> {
  await store().writeFiles(id, { [RECORD_FILES.audit]: JSON.stringify(audit, null, 2) });
}

export async function loadHistoryAudit(id: string): Promise<PersistedAudit | undefined> {
  return store().readOptionalJson<PersistedAudit>(id, RECORD_FILES.audit);
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
  return store().readOptionalJson<CachedArtifacts>(id, RECORD_FILES.artifacts);
}

/** Load a history entry's persisted artifacts by its OWN id — the restore
 *  path's key. A restore re-registers the CSV under a FRESH csvId, so every
 *  csvId-keyed lookup dead-ends for restored analyses; the history id is
 *  the stable key the ?restore= flow actually has. */
export async function loadArtifactsByHistoryId(
  historyId: string
): Promise<CachedArtifacts | undefined> {
  try {
    return await store().readOptionalJson<CachedArtifacts>(historyId, RECORD_FILES.artifacts);
  } catch {
    return undefined;
  }
}

/** Overwrite a history entry's artifacts by its own id (see
 *  loadArtifactsByHistoryId — the restore-then-edit persistence path).
 *  When `spec` is given, the RENDERED spec persists alongside — an edit
 *  that recompiles the dashboard but only persists the plan doc leaves
 *  the record's spec.json stale, so every restore showed the pre-edit
 *  (and pre-fix) rendering while the plan carried the edits. */
export async function updateArtifactsByHistoryId(
  historyId: string,
  artifacts: CachedArtifacts,
  spec?: Record<string, unknown>
): Promise<boolean> {
  try {
    const files: Record<string, string> = {
      [RECORD_FILES.artifacts]: JSON.stringify(artifacts),
    };
    if (spec) {
      files[RECORD_FILES.spec] = JSON.stringify(
        { ...spec, hermeticSpecVersion: HERMETIC_SPEC_VERSION },
        null,
        2
      );
    }
    await store().writeFiles(historyId, files);
    return true;
  } catch {
    return false;
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
    await store().writeFiles(id, { [RECORD_FILES.artifacts]: JSON.stringify(artifacts) });
    return true;
  } catch {
    return false;
  }
}

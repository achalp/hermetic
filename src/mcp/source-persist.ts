/**
 * Durable source_ids across server restarts.
 *
 * Claude Desktop's chat host recycles local MCP servers aggressively — on
 * app restart AND on conversation resume after idle ("Server transport
 * closed (intentional shutdown)" in its logs). Every recycle emptied the
 * in-memory source registry, so the host's next tool call hit "Unknown
 * source_id", the model re-ran connect_source, and the user ate another
 * permission prompt — every single resume.
 *
 * The fix: the registry's csv-family descriptors are written through to
 * `data/mcp-sources.json` on every connect, and a fresh server restores
 * them at boot — re-seeding the CSV store index from the on-disk bytes
 * (which always survived; only the index died). Restores are skipped when
 * the underlying data is truly gone, falling back to today's reattach hint.
 *
 * Boundaries:
 *  - NEVER persisted: credentials. Remote-parquet sources that carried
 *    creds are marked `hadCreds` and NOT restored (reconnect re-derives
 *    creds from env). Warehouse sources hold live credentialed sockets —
 *    not persisted at all; their reattach flow is unchanged.
 *  - Merge-on-write: the Code and Desktop-chat sides run separate hermetic
 *    processes against the same data dir; each upserts only its own
 *    entries so one side's write never clobbers the other's.
 *  - Entries age out after 7 days (matches the scratch-file orphan sweep).
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StoredCSV } from "@/lib/contracts/storage-types";
import { hermeticPaths } from "@/lib/paths";
import type { McpDeps } from "./deps";
import { allSources, getSource, restoreSource, type CsvSource, type SourceOrigin } from "./sources";

/** The McpDeps slice persistence consumes (see LivenessDeps for the pattern). */
export type SourcePersistDeps = Pick<McpDeps, "getStoredCSV" | "restoreStoredCSV">;

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const registryFile = () => join(hermeticPaths.dataDir(), "mcp-sources.json");

interface PersistedSource {
  id: string;
  label: string;
  origin?: SourceOrigin;
  csvId: string;
  schema: CsvSource["schema"];
  remote?: boolean;
  pathBased?: boolean;
  stored: {
    filePath: string;
    localPath?: string;
    localFolderPath?: string;
    localMtime?: number;
    isParquet?: boolean;
    isHivePartitioned?: boolean;
    remoteParquetUrl?: string;
    /** Creds existed but are never written — such entries don't restore. */
    hadCreds?: boolean;
  };
  savedAt: number;
}

async function loadFile(): Promise<PersistedSource[]> {
  try {
    const parsed = JSON.parse(await readFile(registryFile(), "utf-8")) as unknown;
    return Array.isArray(parsed) ? (parsed as PersistedSource[]) : [];
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  return !!(await stat(path).catch(() => null));
}

/**
 * Write-through snapshot of THIS process's csv-family sources, upserted into
 * whatever other processes have written. Best-effort by design: persistence
 * failing must never fail a connect.
 */
export async function persistSources(deps: SourcePersistDeps): Promise<void> {
  try {
    const now = Date.now();
    const mine: PersistedSource[] = [];
    for (const source of allSources()) {
      if (source.kind !== "csv") continue;
      const stored = deps.getStoredCSV(source.csvId);
      if (!stored) continue;
      mine.push({
        id: source.id,
        label: source.label,
        origin: source.origin,
        csvId: source.csvId,
        schema: source.schema,
        remote: source.remote,
        pathBased: source.pathBased,
        stored: {
          filePath: stored.filePath,
          localPath: stored.localPath,
          localFolderPath: stored.localFolderPath,
          localMtime: stored.localMtime,
          isParquet: stored.isParquet,
          isHivePartitioned: stored.isHivePartitioned,
          remoteParquetUrl: stored.remoteParquetUrl,
          ...(stored.remoteCreds ? { hadCreds: true } : {}),
        },
        savedAt: now,
      });
    }
    const merged = new Map((await loadFile()).map((r) => [r.id, r] as const));
    for (const r of mine) merged.set(r.id, r);
    const kept = [...merged.values()].filter((r) => now - r.savedAt < MAX_AGE_MS);
    await mkdir(dirname(registryFile()), { recursive: true });
    await writeFile(registryFile(), JSON.stringify(kept, null, 2) + "\n", "utf-8");
  } catch {
    // Persistence is a convenience layer over a working in-memory registry.
  }
}

/**
 * Boot-time rehydration: re-register every persisted source whose underlying
 * data still exists, under its ORIGINAL id. Data checks per flavor:
 * stored CSV text → the scratch file; local Parquet ref → the user's path;
 * credential-less remote ref → nothing to check (the bucket is the store).
 * Anything unverifiable is skipped — those ids fail with the same
 * reattach hint as before this module existed.
 */
export async function restoreSources(deps: SourcePersistDeps): Promise<number> {
  const records = await loadFile();
  const now = Date.now();
  let restored = 0;
  for (const r of records) {
    if (!r?.id || !r.csvId || !r.schema || now - (r.savedAt ?? 0) > MAX_AGE_MS) continue;
    if (getSource(r.id)) continue; // already live in this process
    if (r.stored?.hadCreds) continue; // creds were never persisted

    if (!deps.getStoredCSV(r.csvId)) {
      const s = r.stored ?? { filePath: "" };
      if (s.localPath || s.localFolderPath) {
        if (!(await exists((s.localPath ?? s.localFolderPath)!))) continue;
      } else if (!s.remoteParquetUrl) {
        if (!s.filePath || !(await exists(s.filePath))) continue;
      }
      const entry: StoredCSV = {
        schema: r.schema,
        filePath: s.filePath ?? "",
        createdAt: now,
        localPath: s.localPath,
        localFolderPath: s.localFolderPath,
        localMtime: s.localMtime,
        isParquet: s.isParquet,
        isHivePartitioned: s.isHivePartitioned,
        remoteParquetUrl: s.remoteParquetUrl,
      };
      deps.restoreStoredCSV(r.csvId, entry);
    }

    restoreSource({
      id: r.id,
      kind: "csv",
      label: r.label,
      origin: r.origin,
      csvId: r.csvId,
      schema: r.schema,
      remote: r.remote,
      pathBased: r.pathBased,
    });
    restored++;
  }
  if (restored > 0) {
    console.error(`[sources] restored ${restored} source(s) from the previous server session`);
  }
  return restored;
}

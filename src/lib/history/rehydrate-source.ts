/**
 * Rehydrate a run's REMOTE source from its durable history record.
 *
 * The in-memory csvId→StoredCSV map dies with the process, but the history
 * record persists the cloud URL (saveHistoryEntry stores remoteParquetUrl).
 * That record — not the ephemeral CSV store and not the capped recent-sources
 * list — is the source of truth for a cloud source: given it, ANY follow-up can
 * go back to the original bucket. Credentials are deliberately NOT in history
 * (secret-at-rest); private buckets re-resolve them from the recent-source
 * keyed by the same URL. Public sources (Overture) need only the URL.
 *
 * Used by RESTORE (registers under the freshly-minted csvId) and, on a cold
 * getStoredCSV miss, by the query path (self-heals a cloud follow-up back to
 * its source instead of failing "CSV not found or expired. Please re-upload.").
 */
import { loadHistoryEntry, type LoadedHistoryEntry } from "./storage";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { loadRecentSources } from "@/lib/sources/recent-sources";
import { logger } from "@/lib/logger";

/** Register a remote-parquet ref from an already-loaded history entry under
 *  `csvId`. Returns false (no-op) when the entry names no remote URL — an
 *  uploaded/local/warehouse source has no bucket to point back at. */
export async function registerRemoteRefFromEntry(
  csvId: string,
  entry: Pick<LoadedHistoryEntry, "schema" | "meta">
): Promise<boolean> {
  const url = entry.meta.remoteParquetUrl;
  if (!url) return false;
  const recent = (await loadRecentSources()).find(
    (r) => r.kind === "remote-parquet" && r.url === url
  );
  storeRemoteParquetRef(
    csvId,
    entry.schema,
    url,
    recent?.creds,
    entry.meta.isHivePartitioned ?? recent?.isHivePartitioned
  );
  return true;
}

/** Load the history entry by id and rehydrate its remote source under `csvId`.
 *  Returns true when a remote ref was registered; false when the id is unknown
 *  or the run had no remote source (nothing to rehydrate). Never throws. */
export async function rehydrateRemoteSourceFromHistory(
  csvId: string,
  historyId: string
): Promise<boolean> {
  const entry = await loadHistoryEntry(historyId).catch(() => null);
  if (!entry) return false;
  const ok = await registerRemoteRefFromEntry(csvId, entry);
  if (ok) logger.info("Rehydrated remote source from history record", { csvId, historyId });
  return ok;
}

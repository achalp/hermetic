import { writeFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import { hermeticPaths } from "@/lib/paths";
import { writeJsonFileAtomic, readJsonFile } from "@/lib/json-file";
import { llmReplayConfig } from "@/lib/llm/replay";
import { logger, errMessage } from "@/lib/logger";
import {
  keychainAvailable,
  getRemoteSourceSecrets,
  setRemoteSourceSecrets,
  deleteRemoteSourceSecrets,
} from "@/lib/secrets";

/**
 * Recent data sources — the file/cloud analogue of the saved warehouse
 * connections (lib/warehouse/persist-env.ts). Remembers every upload, local
 * file/folder, and remote cloud-Parquet URL a user has opened, so they never
 * re-paste a URL or re-pick a file from scratch. Persisted, local-first, under
 * the user's home dir; drag-dropped upload BYTES are copied into a managed
 * store so those too re-open in one click.
 *
 * Warehouses aren't stored here — they already persist in .warehouse-connections
 * .json; the UI merges the two for one unified "Recent" list.
 */
export type RecentKind = "upload" | "local-file" | "local-folder" | "remote-parquet";

export interface RecentSource {
  id: string;
  kind: RecentKind;
  /** Display name — filename, folder name, or URL basename. */
  name: string;
  /** The "where": absolute path or URL, shown muted under the name. */
  subtitle: string;
  rows?: number;
  /** Re-open payloads (per kind). */
  url?: string; // remote-parquet
  creds?: RemoteCreds; // remote-parquet (private buckets — persisted, like warehouses)
  path?: string; // local-file/folder, and the managed copy for an upload
  isHivePartitioned?: boolean;
  /** upload only: the managed byte copy under ~/.hermetic/sources (== path). */
  managed?: boolean;
  lastUsedAt: string;
  useCount: number;
}

// Resolved per call, not at import — module-level consts froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const indexPath = () => hermeticPaths.recentSourcesFile();
const sourcesDir = () => hermeticPaths.savedSourcesDir();
const MAX_ENTRIES = 24;

async function ensureDirs() {
  await mkdir(sourcesDir(), { recursive: true });
}

function dedupKey(kind: RecentKind, target: string): string {
  return `${kind}:${target}`;
}

/** The identity used to dedup a recording (same source → one bumped entry). */
function keyOf(s: Pick<RecentSource, "kind" | "url" | "path" | "name">): string {
  if (s.kind === "remote-parquet") return dedupKey(s.kind, s.url ?? "");
  if (s.kind === "upload") return dedupKey(s.kind, s.name); // by filename
  return dedupKey(s.kind, s.path ?? "");
}

/**
 * Path-backed kinds self-prune: an entry whose file/folder no longer exists
 * (deleted tmp dirs, unmounted drives, cleaned uploads) cannot be re-opened,
 * so keeping it only produces dead identical-looking rows in the Add-data
 * menu (found live: proof-run fixtures in mkdtemp dirs). Remote URLs are
 * never probed — existence there means a network call.
 */
function isOpenable(e: RecentSource): boolean {
  if (e.kind === "remote-parquet") return true;
  return !e.path || existsSync(e.path);
}

// ── Credential separation (finding H1) ───────────────────────────────
// The index FILE persists non-secret metadata only; a private bucket's creds
// live in the OS keychain, one blob per source id. Every write scrubs creds to
// the keychain (leaving the file cred-free); every read merges them back. On a
// system with no credential service the legacy plaintext behavior is kept (a
// headless-deploy escape hatch, matching warehouse persist-env) with a one-time
// warning. Any file that still carries plaintext creds migrates to the keychain
// on the next write that touches the list.

const credFields: (keyof RemoteCreds)[] = [
  "s3Region",
  "s3AccessKeyId",
  "s3SecretAccessKey",
  "s3Endpoint",
];

function credsToRecord(creds: RemoteCreds): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const f of credFields) {
    const v = creds[f];
    if (typeof v === "string" && v !== "") rec[f] = v;
  }
  return rec;
}

function recordToCreds(rec: Record<string, string>): RemoteCreds {
  const creds: RemoteCreds = {};
  for (const f of credFields) {
    if (typeof rec[f] === "string") creds[f] = rec[f];
  }
  return creds;
}

/** Scrub a remote source's creds into the keychain, returning a file-safe copy
 *  with `creds` stripped. On keychain-write failure the creds are kept in the
 *  file (losing a credential is worse than persisting it) and it is logged. */
function scrubCreds(entry: RecentSource): RecentSource {
  if (entry.kind !== "remote-parquet" || !entry.creds) return entry;
  try {
    setRemoteSourceSecrets(entry.id, credsToRecord(entry.creds));
    return { ...entry, creds: undefined };
  } catch (err) {
    logger.warn("recent-sources: keychain write failed — creds kept in file", {
      id: entry.id,
      error: errMessage(err),
    });
    return entry;
  }
}

/** Merge keychain creds back onto an entry that was persisted without them.
 *  A file that still carries plaintext creds (legacy, pre-migration) is kept
 *  as-is rather than overwritten with a possibly-empty keychain blob. */
function withCreds(entry: RecentSource): RecentSource {
  if (entry.kind !== "remote-parquet" || entry.creds) return entry;
  const rec = getRemoteSourceSecrets(entry.id);
  return rec ? { ...entry, creds: recordToCreds(rec) } : entry;
}

let warnedLegacyPlaintext = false;

// Serialize read-modify-write against recent-sources.json so two concurrent
// callers in THIS process can't both read the old list and have the second
// write clobber the first's new entry (finding M8). loadRecentSources re-reads
// disk on each call, so a serialized op also merges a DIFFERENT process's
// concurrent writes (best-effort, matching the warehouse merge-on-write).
let writeChain: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function loadRecentSources(): Promise<RecentSource[]> {
  let list: RecentSource[] | undefined;
  try {
    // Missing → undefined (fresh list); corrupt → backed up, undefined
    // returned (NOT silently [], which the prune-write below would then flush
    // over the salvageable bytes). A transient read error throws — caught here
    // and returned empty WITHOUT writing, so a hiccup never wipes the index.
    list = await readJsonFile<RecentSource[]>(indexPath(), {
      validate: (p): p is RecentSource[] => Array.isArray(p),
    });
  } catch {
    return [];
  }
  if (!list) return [];
  const live = list.filter(isOpenable);
  if (live.length !== list.length) {
    // Best-effort persist of the prune so the dead rows don't reappear.
    await write(live).catch(() => {});
  }
  return live.map(withCreds).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}

/** THE single write path: scrub credentials to the keychain, then file. */
async function write(list: RecentSource[]): Promise<void> {
  await ensureDirs();
  let toDisk = list;
  if (keychainAvailable()) {
    toDisk = list.map(scrubCreds);
  } else if (list.some((e) => e.kind === "remote-parquet" && e.creds) && !warnedLegacyPlaintext) {
    warnedLegacyPlaintext = true;
    logger.warn(
      "recent-sources: no OS credential service — bucket credentials remain in " +
        "recent-sources.json (legacy plaintext mode)"
    );
  }
  await writeJsonFileAtomic(indexPath(), toDisk);
}

/** Best-effort delete of an upload's managed byte copy AND any keychain creds. */
async function deleteManaged(entry: RecentSource): Promise<void> {
  if (entry.kind === "upload" && entry.path) await unlink(entry.path).catch(() => {});
  if (entry.kind === "remote-parquet") deleteRemoteSourceSecrets(entry.id);
}

export interface RecordInput {
  kind: RecentKind;
  name: string;
  subtitle: string;
  rows?: number;
  url?: string;
  creds?: RemoteCreds;
  path?: string;
  isHivePartitioned?: boolean;
  /** upload only: raw bytes to persist so the file re-opens later. */
  bytes?: Buffer | string;
  /** upload only: original filename, used to pick the managed file's extension. */
  filename?: string;
}

/**
 * Record (or bump) a recently-opened source. Deduplicates by identity, moves the
 * entry to the front, caps the list (evicting the least-recently-used and its
 * managed bytes). Best-effort: never throws into a connect flow.
 */
export async function recordRecentSource(input: RecordInput): Promise<void> {
  await serializeWrite(async () => {
    try {
      // Replay-mode runs are tests (CI proofs, golden journeys) driving the
      // real server with fixture files in throwaway dirs — recording those
      // would pollute the user's actual recents (found live: five
      // /tmp/mcp-proof-*/fixture.csv rows in the Add-data menu).
      if (llmReplayConfig()?.mode === "replay") return;
      const list = await loadRecentSources();
      const now = new Date().toISOString();
      const key = keyOf(input);
      const existing = list.find((e) => keyOf(e) === key);

      let path = input.path;
      // Persist upload bytes into the managed store so the file re-opens in one
      // click. The dir lives under the home dir, so it's inside the local-file
      // root-jail and re-opens through the ordinary local-schema path.
      if (input.kind === "upload" && input.bytes != null) {
        await ensureDirs();
        const id = existing?.id ?? randomUUID();
        const ext = extname(input.filename ?? input.name) || ".csv";
        path = join(sourcesDir(), `${id}${ext}`);
        await writeFile(path, input.bytes);
      }

      if (existing) {
        existing.name = input.name;
        existing.subtitle = input.subtitle;
        existing.rows = input.rows ?? existing.rows;
        existing.url = input.url ?? existing.url;
        existing.creds = input.creds ?? existing.creds;
        existing.path = path ?? existing.path;
        existing.isHivePartitioned = input.isHivePartitioned ?? existing.isHivePartitioned;
        existing.lastUsedAt = now;
        existing.useCount += 1;
      } else {
        list.push({
          id: randomUUID(),
          kind: input.kind,
          name: input.name,
          subtitle: input.subtitle,
          rows: input.rows,
          url: input.url,
          creds: input.creds,
          path,
          isHivePartitioned: input.isHivePartitioned,
          managed: input.kind === "upload" ? true : undefined,
          lastUsedAt: now,
          useCount: 1,
        });
      }

      list.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
      // Evict the least-recently-used past the cap (and their managed bytes).
      for (const evicted of list.splice(MAX_ENTRIES)) await deleteManaged(evicted);
      await write(list);
    } catch {
      // Recording is a convenience — a failure must never break a connect.
    }
  });
}

export async function renameRecentSource(id: string, name: string): Promise<void> {
  await serializeWrite(async () => {
    const list = await loadRecentSources();
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    entry.name = name.trim() || entry.name;
    await write(list);
  });
}

export async function removeRecentSource(id: string): Promise<void> {
  await serializeWrite(async () => {
    const list = await loadRecentSources();
    const entry = list.find((e) => e.id === id);
    if (!entry) return;
    await deleteManaged(entry);
    await write(list.filter((e) => e.id !== id));
  });
}

export async function clearRecentSources(): Promise<void> {
  await serializeWrite(async () => {
    const list = await loadRecentSources();
    for (const entry of list) await deleteManaged(entry);
    await write([]);
  });
}

/** Look up one entry (for re-open — the client needs its stored payload). */
export async function getRecentSource(id: string): Promise<RecentSource | undefined> {
  return (await loadRecentSources()).find((e) => e.id === id);
}

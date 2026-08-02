import "server-only";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RemoteCreds } from "@/lib/contracts/storage-types";

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

const DIR = join(homedir(), ".hermetic");
const INDEX_PATH = join(DIR, "recent-sources.json");
const SOURCES_DIR = join(DIR, "sources");
const MAX_ENTRIES = 24;

async function ensureDirs() {
  await mkdir(SOURCES_DIR, { recursive: true });
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

export async function loadRecentSources(): Promise<RecentSource[]> {
  try {
    const raw = await readFile(INDEX_PATH, "utf-8");
    const list = JSON.parse(raw) as RecentSource[];
    return list.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  } catch {
    return [];
  }
}

async function write(list: RecentSource[]): Promise<void> {
  await ensureDirs();
  await writeFile(INDEX_PATH, JSON.stringify(list, null, 2), "utf-8");
}

/** Best-effort delete of an upload's managed byte copy. */
async function deleteManaged(entry: RecentSource): Promise<void> {
  if (entry.kind === "upload" && entry.path) await unlink(entry.path).catch(() => {});
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
  try {
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
      path = join(SOURCES_DIR, `${id}${ext}`);
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
}

export async function renameRecentSource(id: string, name: string): Promise<void> {
  const list = await loadRecentSources();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  entry.name = name.trim() || entry.name;
  await write(list);
}

export async function removeRecentSource(id: string): Promise<void> {
  const list = await loadRecentSources();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  await deleteManaged(entry);
  await write(list.filter((e) => e.id !== id));
}

export async function clearRecentSources(): Promise<void> {
  const list = await loadRecentSources();
  for (const entry of list) await deleteManaged(entry);
  await write([]);
}

/** Look up one entry (for re-open — the client needs its stored payload). */
export async function getRecentSource(id: string): Promise<RecentSource | undefined> {
  return (await loadRecentSources()).find((e) => e.id === id);
}

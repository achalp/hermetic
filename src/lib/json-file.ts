/**
 * Crash-safe JSON file primitives shared by every on-disk store.
 *
 * Before this module, only lib/runtime-config.ts wrote atomically; every other
 * JSON store did a bare writeFile that truncates the file the instant the
 * process dies mid-write. Paired with a catch-all "return []" read, a truncated
 * file silently wiped the store on the NEXT write. These two helpers are the one
 * owner of the safe pattern:
 *
 *   - writeFileAtomic / writeJsonFileAtomic: serialize to a pid+random-suffixed
 *     temp file in the SAME directory, then rename(2) over the target. rename is
 *     atomic within a filesystem, so a crash leaves either the whole old file or
 *     the whole new one — never a partial. The temp name is uniquely suffixed
 *     (NOT a fixed `.tmp`) so two processes writing the same target never race
 *     onto the same temp path.
 *
 *   - readJsonFile: distinguishes the three outcomes a bare try/catch conflates.
 *     ENOENT (the normal first-run state) → undefined. A genuine JSON.parse (or
 *     shape) failure → back the file up to `${path}.corrupt-<ts>` before any
 *     caller's next write can overwrite the only copy, then return undefined. A
 *     TRANSIENT read error (EMFILE/EACCES/…) → rethrow: never rename the only
 *     copy on a hiccup, and never let the caller fall through to a wipe.
 */
import { readFile, writeFile, rename, mkdir, unlink } from "fs/promises";
import { dirname } from "path";
import { randomBytes } from "crypto";
import { logger } from "@/lib/logger";

/** Write `content` to `path` atomically (temp-in-same-dir + rename). */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    // Never leave the scratch temp behind on failure.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Serialize `data` to pretty JSON and write it atomically. */
export async function writeJsonFileAtomic(path: string, data: unknown): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(data, null, 2));
}

/**
 * Best-effort rename of a corrupt file to `${path}.corrupt-<ts>` so it is
 * preserved (and out of the way) before the next write overwrites it. Returns
 * the backup path, or undefined if the rename itself failed.
 */
export async function backupCorruptFile(path: string): Promise<string | undefined> {
  const backupPath = `${path}.corrupt-${Date.now()}`;
  return rename(path, backupPath).then(
    () => backupPath,
    () => undefined
  );
}

export interface ReadJsonOptions<T> {
  /**
   * Extra shape check applied AFTER a successful parse (e.g. Array.isArray). A
   * parsed-but-wrong-shape file is treated as corrupt: backed up, undefined
   * returned — a `{}` where a `[]` was expected must not flow through as data.
   */
  validate?: (parsed: unknown) => parsed is T;
  /** Called after a corrupt file is backed up (parse OR validate failure). */
  onCorrupt?: (info: { path: string; backupPath?: string; error: unknown }) => void;
}

/**
 * Read + parse a JSON file. Returns undefined for a missing file (ENOENT) and
 * for a corrupt one (after backing it up); rethrows transient read errors so a
 * caller never wipes the only copy on a hiccup.
 */
export async function readJsonFile<T = unknown>(
  path: string,
  opts: ReadJsonOptions<T> = {}
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    // ENOENT is the normal empty state; anything else (EMFILE/EACCES/EIO/…) is
    // a transient failure — propagate it, do NOT rename or silently empty.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return handleCorrupt<T>(path, err, opts);
  }
  if (opts.validate && !opts.validate(parsed)) {
    return handleCorrupt<T>(path, new Error("parsed JSON failed shape validation"), opts);
  }
  return parsed as T;
}

async function handleCorrupt<T>(
  path: string,
  error: unknown,
  opts: ReadJsonOptions<T>
): Promise<undefined> {
  const backupPath = await backupCorruptFile(path);
  logger.warn(`${path} unreadable — backed up, starting fresh`, {
    path,
    backupPath,
    error: error instanceof Error ? error.message : String(error),
  });
  opts.onCorrupt?.({ path, backupPath, error });
  return undefined;
}

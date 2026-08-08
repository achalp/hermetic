import { mkdir, writeFile, readFile, readdir, rm, rename, stat } from "fs/promises";
import { join } from "path";

/**
 * Shared store for record directories (modularization M2-C3, spec §3.2
 * RecordStore).
 *
 * History entries and saved visualizations persist the same way — a
 * UUID-named directory of well-known files — but each module independently
 * hand-rolled the layout, the corrupt-entry skipping, the uuid validation,
 * and the archive list (which is how saved-viz archiving silently dropped
 * schema.json for months). The layout now has one owner.
 */

/** The well-known record files. THE layout definition — nothing else names these. */
export const RECORD_FILES = {
  meta: "meta.json",
  spec: "spec.json",
  code: "code.py",
  schema: "schema.json",
  source: "source.csv",
  artifacts: "artifacts.json",
  workbook: "workbook.json",
  /** On-demand non-blind audit verdict (composer-sight spec §3). */
  audit: "audit.json",
} as const;

export type RecordFile = (typeof RECORD_FILES)[keyof typeof RECORD_FILES];

/** Typed failure for a missing/unparsable record file — replaces raw ENOENT. */
export class RecordCorruptError extends Error {
  constructor(
    public readonly recordId: string,
    public readonly file: string,
    public readonly reason: string
  ) {
    super(`Record ${recordId} is corrupt: ${file} — ${reason}`);
    this.name = "RecordCorruptError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RecordDirStore {
  private rootCreated = false;

  constructor(private readonly root: string) {}

  /** Reject non-UUID ids (path-traversal guard, shared by all callers). */
  validateId(id: string): void {
    if (!UUID_RE.test(id)) throw new Error("Invalid record ID");
  }

  dir(id: string): string {
    this.validateId(id);
    return join(this.root, id);
  }

  async ensureDir(id?: string): Promise<string> {
    if (!this.rootCreated) {
      await mkdir(this.root, { recursive: true });
      this.rootCreated = true;
    }
    if (!id) return this.root;
    const d = this.dir(id);
    await mkdir(d, { recursive: true });
    return d;
  }

  /** Write named files (already-serialized) into a record dir in parallel. */
  async writeFiles(id: string, files: Record<string, string>): Promise<void> {
    const d = await this.ensureDir(id);
    await Promise.all(
      Object.entries(files).map(([name, content]) => writeFile(join(d, name), content, "utf-8"))
    );
  }

  /** Read + parse a REQUIRED JSON file; missing/unparsable → RecordCorruptError. */
  async readRequiredJson<T>(id: string, file: string): Promise<T> {
    const raw = await this.readRequiredText(id, file);
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      throw new RecordCorruptError(id, file, e instanceof Error ? e.message : "invalid JSON");
    }
  }

  async readRequiredText(id: string, file: string): Promise<string> {
    try {
      return await readFile(join(this.dir(id), file), "utf-8");
    } catch (e) {
      throw new RecordCorruptError(id, file, e instanceof Error ? e.message : "unreadable");
    }
  }

  /** Read + parse an OPTIONAL JSON file; missing/unparsable → undefined. */
  async readOptionalJson<T>(id: string, file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), file), "utf-8")) as T;
    } catch {
      return undefined;
    }
  }

  async readOptionalText(id: string, file: string): Promise<string | undefined> {
    try {
      return await readFile(join(this.dir(id), file), "utf-8");
    } catch {
      return undefined;
    }
  }

  /** All record metas (corrupt entries skipped), unsorted — caller orders. */
  async listMetas<T>(): Promise<T[]> {
    try {
      await this.ensureDir();
      const entries = await readdir(this.root, { withFileTypes: true });
      const metas: T[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const raw = await readFile(join(this.root, entry.name, RECORD_FILES.meta), "utf-8");
          metas.push(JSON.parse(raw));
        } catch {
          // Skip corrupted entries — a bad record must not hide the rest.
        }
      }
      return metas;
    } catch {
      return [];
    }
  }

  /** Move the given record files into a subdirectory (best-effort per file). */
  async archiveFiles(id: string, files: readonly string[], subdir: string): Promise<void> {
    const d = this.dir(id);
    const target = join(d, subdir);
    await mkdir(target, { recursive: true });
    await Promise.all(
      files.map(async (f) => {
        try {
          await stat(join(d, f));
          await rename(join(d, f), join(target, f));
        } catch {
          // File may legitimately not exist for this record.
        }
      })
    );
  }

  async delete(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}

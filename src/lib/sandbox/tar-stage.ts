/**
 * Minimal USTAR archive builder for batched container file staging (perf P2).
 *
 * Staging files one `docker exec cat > file` at a time cost ~13 docker-CLI
 * spawns per ephemeral run (input.csv, geojson, ~10 runtime files, script.py) —
 * tens of ms each. `docker cp - <id>:/data` accepts a tar archive on stdin and
 * extracts it in ONE daemon round-trip, so all text staging collapses into a
 * single spawn. This module builds that archive deterministically (fixed mtime,
 * fixed ownership) with no external tar dependency.
 *
 * Scope is deliberately narrow: ASCII-pathed text files under /data with names
 * short enough for the plain ustar name field. Anything outside that contract
 * throws — the caller falls back to the per-file exec path rather than risk a
 * silently mangled archive.
 */

export interface StageFile {
  /** Absolute in-container path, must start with /data/. */
  path: string;
  content: string;
}

const BLOCK = 512;
/** Extraction perms: files world-writable so the non-root sandbox user can
 *  overwrite/append them even though `docker cp` extracts as root; dirs 0777 so
 *  Python can drop __pycache__ into hermetic_runtime. Matches the effective
 *  capabilities of the old `docker exec cat` staging (which wrote as the
 *  sandbox user). */
const FILE_MODE = 0o666;
const DIR_MODE = 0o777;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number, typeflag: "0" | "5", mode: number): Buffer {
  if (name.length >= 100) {
    throw new Error(`tar-stage: entry name too long for ustar name field: ${name}`);
  }
  if (/[^\x20-\x7e]/.test(name)) {
    throw new Error(`tar-stage: non-ASCII entry name: ${name}`);
  }
  const buf = Buffer.alloc(BLOCK);
  buf.write(name, 0, "ascii");
  buf.write(octal(mode, 8), 100, "ascii");
  buf.write(octal(0, 8), 108, "ascii"); // uid
  buf.write(octal(0, 8), 116, "ascii"); // gid
  buf.write(octal(size, 12), 124, "ascii");
  buf.write(octal(0, 12), 136, "ascii"); // mtime: fixed for determinism
  buf.write("        ", 148, "ascii"); // chksum: spaces while summing
  buf.write(typeflag, 156, "ascii");
  buf.write("ustar\0" + "00", 257, "ascii"); // magic + version
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return buf;
}

function pad(content: Buffer): Buffer {
  const rem = content.length % BLOCK;
  return rem === 0 ? content : Buffer.concat([content, Buffer.alloc(BLOCK - rem)]);
}

/** In-container path → archive-relative name (extraction target is /data). */
function relName(path: string): string {
  if (!path.startsWith("/data/")) {
    throw new Error(`tar-stage: path must live under /data/: ${path}`);
  }
  const rel = path.slice("/data/".length);
  if (rel.length === 0 || rel.includes("..")) {
    throw new Error(`tar-stage: unsafe path: ${path}`);
  }
  return rel;
}

/**
 * Build a USTAR archive for `docker cp - <id>:/data`. Emits explicit directory
 * entries for every nested parent (Docker creates missing parents anyway, but
 * explicit entries pin the 0777 mode) followed by the file entries.
 */
export function buildTarArchive(files: StageFile[]): Buffer {
  const parts: Buffer[] = [];
  const dirs = new Set<string>();
  for (const f of files) {
    const rel = relName(f.path);
    // Collect every ancestor dir (e.g. "a/b/c.py" → "a/", "a/b/").
    const segs = rel.split("/");
    for (let i = 1; i < segs.length; i++) {
      dirs.add(segs.slice(0, i).join("/") + "/");
    }
  }
  for (const dir of [...dirs].sort()) {
    parts.push(header(dir, 0, "5", DIR_MODE));
  }
  for (const f of files) {
    const content = Buffer.from(f.content, "utf-8");
    parts.push(header(relName(f.path), content.length, "0", FILE_MODE));
    parts.push(pad(content));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(parts);
}

/** Entry names in an archive built by buildTarArchive — for tests/sanity. */
export function listTarEntryNames(archive: Buffer): string[] {
  const names: string[] = [];
  let off = 0;
  while (off + BLOCK <= archive.length) {
    const block = archive.subarray(off, off + BLOCK);
    if (block.every((b) => b === 0)) break; // end-of-archive
    const nul = block.indexOf(0);
    names.push(block.subarray(0, nul === -1 ? 100 : nul).toString("ascii"));
    const size = parseInt(block.subarray(124, 136).toString("ascii").trim() || "0", 8);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return names;
}

/**
 * Append-only audit log for MCP tool calls (mcp-server spec §3 cross-cutting
 * defaults; on by default — traceability is not opt-in).
 *
 * One JSONL line per call: timestamp, tool, source id, SANITIZED args,
 * outcome, duration. Sanitization policy: never log data values — SQL and
 * code are truncated previews, file paths are kept (they identify the source,
 * not its contents), everything else passes through only if it is a short
 * scalar.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { hermeticPaths } from "@/lib/paths";
import { logger, errMessage } from "@/lib/logger";
import { getSecret, setSecret, keychainAvailable } from "@/lib/secrets";

export interface AuditEntry {
  ts: string;
  tool: string;
  sourceId?: string;
  /**
   * Pipeline run id, when the tool result carried one (analyze) — the join
   * key to the run's server logs, diagnostics JSONL, and cost row.
   */
  runId?: string;
  args: Record<string, unknown>;
  outcome: "ok" | "error" | "rejected";
  /** Present only for outcome !== "ok"; message, never a stack. */
  error?: string;
  /** Taxonomy code for outcome "error" (src/mcp/errors.ts). */
  code?: string;
  durationMs: number;
}

const PREVIEW_KEYS = new Set(["sql", "python", "question", "prose", "title"]);
const MAX_PREVIEW = 200;
/** Keys whose values are URLs — query strings can carry signed credentials. */
const URL_KEYS = new Set(["url"]);

/**
 * A presigned S3/GCS URL carries X-Amz-Credential / X-Amz-Signature (or a
 * GCS token) in its query string. Logging it verbatim would write live
 * credentials into an append-only file with no rotation, so the query is
 * dropped and only its presence recorded.
 */
export function redactUrl(value: string): string {
  const q = value.indexOf("?");
  return q === -1 ? value : `${value.slice(0, q)}?<query-redacted>`;
}

export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") {
      if (URL_KEYS.has(k)) {
        out[k] = redactUrl(v);
        continue;
      }
      out[k] = PREVIEW_KEYS.has(k) && v.length > MAX_PREVIEW ? `${v.slice(0, MAX_PREVIEW)}…` : v;
      if (!PREVIEW_KEYS.has(k) && typeof out[k] === "string" && (out[k] as string).length > 500) {
        out[k] = `${(out[k] as string).slice(0, 500)}…`;
      }
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
    } else if (v !== undefined) {
      // Objects (specs, artifacts) are summarized, never logged.
      out[k] = `<${Array.isArray(v) ? "array" : "object"}>`;
    }
  }
  return out;
}

export type AuditSink = (entry: AuditEntry) => void;

/**
 * Rotation threshold: the MCP process lives as long as its host app and the
 * file was append-only with no bound. Rotation keeps AUDIT_KEEP numbered
 * generations (shifted, not overwritten — the old `rename(file, file.1)` lost
 * every generation but the newest on the second rotation).
 *
 * Integrity note: a per-line keychain-HMAC hash chain (tamper-evidence) was
 * considered but deferred — the MCP audit file can be appended by more than one
 * MCP process (Desktop + Code), so an in-process chain would fork under
 * concurrent writes; a robust version needs per-write locking + a keychain read
 * and is its own change. This fix closes the concrete gaps: silent data loss on
 * rotation, silent write failures, and a world-readable file.
 */
export const AUDIT_ROTATE_BYTES = 5 * 1024 * 1024;
export const AUDIT_KEEP = 3;

/** Shift generations file.(N-1)→file.N … file.1→file.2, file→file.1 (no loss). */
function rotateAudit(file: string): void {
  for (let i = AUDIT_KEEP - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (existsSync(from)) renameSync(from, `${file}.${i + 1}`);
  }
  renameSync(file, `${file}.1`);
}

/** Default sink: JSONL under the data root (hermeticPaths owns the layout). */
// ── Tamper-evident hash chain ─────────────────────────────────────────
// Each line carries `h` = HMAC-SHA256(key, prevH + <the line's JSON minus h>).
// An edit, reorder, or deletion of any non-final line breaks the chain from
// that point, and without the key an attacker cannot recompute a valid `h`.
// (A plain chain can't prove the TAIL wasn't truncated — that needs an external
// length/last-hash anchor; out of scope here.) The key lives
// in the OS keychain (a local attacker with file-write cannot forge); on a
// keychain-less host (headless Linux, no Secret Service) it falls back to a
// 0600 key file beside the log — weaker (a reader can forge) but still detects
// accidental corruption. Cross-process writers (Desktop + Code) serialize on a
// lockfile so the chain never forks.
const AUDIT_KEY_SECRET = "mcp-audit-hmac-key";
let cachedKey: Buffer | null = null;

function auditKey(file: string): Buffer {
  if (cachedKey) return cachedKey;
  let hex = getSecret(AUDIT_KEY_SECRET);
  if (!hex && keychainAvailable()) {
    hex = randomBytes(32).toString("hex");
    setSecret(AUDIT_KEY_SECRET, hex);
  }
  if (!hex) {
    const keyFile = `${file}.key`;
    try {
      hex = readFileSync(keyFile, "utf8").trim();
    } catch {
      hex = randomBytes(32).toString("hex");
      writeFileSync(keyFile, hex, { mode: 0o600 });
    }
  }
  cachedKey = Buffer.from(hex, "hex");
  return cachedKey;
}

/** Test-only: drop the cached HMAC key so a fresh keychain state is picked up. */
export function _resetAuditKeyForTests(): void {
  cachedKey = null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Serialize appends across processes on a lockfile; break a stale lock. */
function withAuditLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock); // holder died
      } catch {
        // lock vanished between calls — retry
      }
      if (Date.now() > deadline) {
        try {
          unlinkSync(lock);
        } catch {
          // ignore
        }
        fd = openSync(lock, "w"); // waited long enough; take it
        break;
      }
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(lock);
    } catch {
      // ignore
    }
  }
}

/** The last chain hash of a single file, or "" if absent/empty. */
function lastHashOf(f: string): string {
  try {
    const lines = readFileSync(f, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i]) continue;
      const h = (JSON.parse(lines[i]) as { h?: unknown }).h;
      if (typeof h === "string") return h;
    }
  } catch {
    // absent / unreadable
  }
  return "";
}

/** The hash the next append chains to — live file's last, else the rotated `.1`. */
function lastHash(file: string): string {
  return lastHashOf(file) || lastHashOf(`${file}.1`);
}

export function fileAuditSink(): AuditSink {
  return (entry) => {
    try {
      const file = hermeticPaths.mcpAuditFile();
      mkdirSync(dirname(file), { recursive: true });
      withAuditLock(file, () => {
        try {
          if (statSync(file).size > AUDIT_ROTATE_BYTES) rotateAudit(file);
        } catch {
          // ENOENT on first write, or a failed stat/rotate — append regardless.
        }
        const payload = JSON.stringify(entry);
        const h = createHmac("sha256", auditKey(file))
          .update(lastHash(file))
          .update(payload)
          .digest("hex");
        // 0600: the log names sources/tools; it must not be world-readable.
        appendFileSync(file, JSON.stringify({ ...entry, h }) + "\n", { mode: 0o600 });
      });
    } catch (err) {
      // Audit must never take the tool call down — but a swallowed write is
      // indistinguishable from "no tool call", so make the failure visible.
      logger.warn("MCP audit write failed", { error: errMessage(err) });
    }
  };
}

/** Verify the chain: recompute each line's HMAC over (prevH + line-without-h).
 *  Returns the 1-based line where it first breaks, or ok. */
export function verifyAuditChain(file: string = hermeticPaths.mcpAuditFile()): {
  ok: boolean;
  brokenLine?: number;
} {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").trimEnd().split("\n").filter(Boolean);
  } catch {
    return { ok: true }; // no log yet
  }
  const key = auditKey(file);
  // The first live line chained to the previous generation's last hash (if the
  // log has rotated); seed prev with it so a rotation doesn't read as a break.
  let prev = lastHashOf(`${file}.1`);
  for (let i = 0; i < lines.length; i++) {
    const { h, ...entry } = JSON.parse(lines[i]) as Record<string, unknown> & { h?: string };
    const expected = createHmac("sha256", key)
      .update(prev)
      .update(JSON.stringify(entry))
      .digest("hex");
    if (h !== expected) return { ok: false, brokenLine: i + 1 };
    prev = h;
  }
  return { ok: true };
}

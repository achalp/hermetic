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
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { hermeticPaths } from "@/lib/paths";
import { logger, errMessage } from "@/lib/logger";

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
export function fileAuditSink(): AuditSink {
  return (entry) => {
    try {
      const file = hermeticPaths.mcpAuditFile();
      mkdirSync(dirname(file), { recursive: true });
      try {
        if (statSync(file).size > AUDIT_ROTATE_BYTES) rotateAudit(file);
      } catch {
        // ENOENT on first write, or a failed stat/rotate — append regardless.
      }
      // 0600: the audit log names sources/tools; it must not be world-readable.
      // mode applies on creation only, which is exactly the new-file case.
      appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (err) {
      // Audit must never take the tool call down — but a swallowed write is
      // indistinguishable from "no tool call", so make the failure visible.
      logger.warn("MCP audit write failed", { error: errMessage(err) });
    }
  };
}

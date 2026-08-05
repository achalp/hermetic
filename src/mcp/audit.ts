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
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hermeticPaths } from "@/lib/paths";

export interface AuditEntry {
  ts: string;
  tool: string;
  sourceId?: string;
  args: Record<string, unknown>;
  outcome: "ok" | "error" | "rejected";
  /** Present only for outcome !== "ok"; message, never a stack. */
  error?: string;
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

/** Default sink: JSONL under the data root (hermeticPaths owns the layout). */
export function fileAuditSink(): AuditSink {
  return (entry) => {
    try {
      const file = hermeticPaths.mcpAuditFile();
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(entry) + "\n");
    } catch {
      // Audit must never take the tool call down with it.
    }
  };
}

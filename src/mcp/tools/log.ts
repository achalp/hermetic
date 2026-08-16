/**
 * Structured entry/exit/error logging for MCP tools (finding 03 —
 * observability). Seven of the eight tools emitted zero logger lines: the audit
 * JSONL (src/mcp/audit.ts) records calls to its own file, but nothing reached
 * the structured server log the web routes use, so a failing MCP call left no
 * server-side trace to correlate against a run's diagnostics/cost rows.
 *
 * This wraps a tool body: one info line on entry, one on success (with elapsed
 * ms), one error line on throw — then RE-THROWS the original error unchanged, so
 * the tool's output contract and the MCP error taxonomy (src/mcp/errors.ts) are
 * untouched. `meta` should carry only identifying scalars (source_id, path,
 * history_id) — never data values; the logger additionally caps long strings and
 * redacts secret-shaped keys.
 */
import { logger, errMessage } from "@/lib/logger";

export async function withToolLog<T>(
  tool: string,
  meta: Record<string, unknown>,
  run: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  logger.info("MCP tool start", { tool, ...meta });
  try {
    const result = await run();
    logger.info("MCP tool ok", { tool, durationMs: Date.now() - started });
    return result;
  } catch (err) {
    logger.error("MCP tool failed", {
      tool,
      durationMs: Date.now() - started,
      error: errMessage(err),
    });
    throw err;
  }
}

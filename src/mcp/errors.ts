/**
 * MCP error taxonomy (RPC hygiene, spec §8).
 *
 * An RPC surface owes its caller machine-readable failure classes, not
 * ad-hoc strings: a host that gets `source_expired` can re-attach and retry
 * without a human reading prose. The message stays the human-facing,
 * actionable part; `code` is the contract.
 *
 * Codes are a closed set — add one only when a host would genuinely react
 * differently to it:
 *
 * - `unknown_source`     — source_id not in this session's registry
 * - `source_expired`     — source was attached but its data/connection idled out
 * - `unsupported_source` — the tool refuses this source type (capability mismatch)
 * - `invalid_input`      — arguments malformed or contradictory
 * - `sql_rejected`       — read-only SQL gate refused the statement
 * - `spec_rejected`      — dashboard spec failed enforcing catalog validation
 * - `execution_failed`   — sandbox/pipeline ran and failed
 * - `internal`           — anything uncoded (the fallback, never thrown directly)
 */
export type McpErrorCode =
  | "unknown_source"
  | "source_expired"
  | "unsupported_source"
  | "invalid_input"
  | "sql_rejected"
  | "spec_rejected"
  | "execution_failed"
  | "internal";

export class McpToolError extends Error {
  constructor(
    public readonly code: Exclude<McpErrorCode, "internal">,
    message: string
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export function errorCodeOf(err: unknown): McpErrorCode {
  return err instanceof McpToolError ? err.code : "internal";
}

export function unknownSource(sourceId: string): McpToolError {
  return new McpToolError(
    "unknown_source",
    `Unknown source_id '${sourceId}'. Call connect_source first.`
  );
}

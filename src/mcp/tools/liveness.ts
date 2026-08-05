/**
 * Source liveness (reliability #1).
 *
 * The MCP registry holds a source for the life of the process, but the
 * underlying stores expire on a sliding idle TTL (3h) — and for warehouses
 * the sweeper CLOSES the connector on the way out. Without this check the
 * failure surfaces as a raw driver error ("Cannot use a pool after calling
 * end") or a web-app string ("CSV not found. Please re-upload."), neither of
 * which tells an MCP host what to do.
 *
 * The message names the source, the cause, and the exact call that re-attaches
 * it — the registry records how it was attached for precisely this reason.
 */
import { CSV_TTL_MS } from "@/lib/constants";
import type { McpDeps } from "../deps";
import { reattachHint, type McpSource } from "../sources";
import { McpToolError } from "../errors";

const IDLE_HOURS = Math.round(CSV_TTL_MS / (60 * 60 * 1000));

export function assertSourceLive(deps: McpDeps, source: McpSource): void {
  const live =
    source.kind === "warehouse"
      ? !!deps.getWarehouseState(source.id)
      : !!deps.getStoredCSV(source.csvId);
  if (live) return;

  const what =
    source.kind === "warehouse"
      ? `The warehouse connection "${source.label}" was closed after ${IDLE_HOURS}h idle`
      : `The data for "${source.label}" expired from hermetic's store after ${IDLE_HOURS}h idle`;

  throw new McpToolError(
    "source_expired",
    `${what}, so source_id ${source.id} is no longer usable. ${reattachHint(source.origin)} ` +
      "A re-attach produces a NEW source_id; the old one stays dead."
  );
}

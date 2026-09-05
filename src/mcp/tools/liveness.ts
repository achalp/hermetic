/**
 * Source liveness (reliability #1).
 *
 * The MCP registry holds a source for the life of the process, but the
 * warehouse store expires idle connections (3h — credentialed sockets), and
 * a server restart empties the in-memory CSV index (CSV/remote entries no
 * longer idle-expire; retention policy in lib/csv/storage.ts). Without this check the
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

/**
 * The McpDeps slice liveness needs. Every tool `Pick`s exactly what it uses
 * (review fix: compile-checked narrowing at the consumption site) so test
 * fakes only have to supply the members a tool actually reads.
 */
export type LivenessDeps = Pick<
  McpDeps,
  "getWarehouseState" | "getStoredCSV" | "getManifestRecord"
>;

const IDLE_HOURS = Math.round(CSV_TTL_MS / (60 * 60 * 1000));

export function assertSourceLive(deps: LivenessDeps, source: McpSource): void {
  const live =
    source.kind === "warehouse"
      ? !!deps.getWarehouseState(source.id)
      : source.kind === "manifest"
        ? !!deps.getManifestRecord?.(source.manifestId)
        : !!deps.getStoredCSV(source.csvId);
  if (live) return;

  const what =
    source.kind === "warehouse"
      ? `The warehouse connection "${source.label}" was closed after ${IDLE_HOURS}h idle`
      : source.kind === "manifest"
        ? `The manifest "${source.label}" is no longer in hermetic's store (the server restarted since it was attached)`
        : `The data for "${source.label}" is no longer in hermetic's store (the server restarted since it was attached)`;

  throw new McpToolError(
    "source_expired",
    `${what}, so source_id ${source.id} is no longer usable. ${reattachHint(source.origin)} ` +
      "A re-attach produces a NEW source_id; the old one stays dead."
  );
}

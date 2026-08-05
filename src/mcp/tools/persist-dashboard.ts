/**
 * persist_dashboard — persist a HOST-AUTHORED spec as a viewable history
 * entry (mcp-server spec §3, pillar: artifact; §4 M5 hardening).
 *
 * Validation is ENFORCING here, not warn-only: everywhere else hermetic
 * persists specs its own pipeline composed (warn-only protects the user's
 * save), but an MCP host is an untrusted spec author — the exact case the
 * Phase 2a trust model names. An invalid spec is rejected with the zod
 * error so the host can correct it; nothing is persisted.
 */
import { z } from "zod";
import type { McpDeps } from "../deps";
import { getSource } from "../sources";
import { assertSourceLive } from "./liveness";
import { viewUrl } from "../view-url";
import { McpToolError, unknownSource } from "../errors";

/** The McpDeps slice persist_dashboard consumes (see LivenessDeps for the pattern). */
export type PersistDashboardDeps = Pick<
  McpDeps,
  | "validateSpec"
  | "catalogComponentNames"
  | "persistHistoryEntry"
  | "getWarehouseState"
  | "getStoredCSV"
>;

export const persistDashboardInput = {
  source_id: z.string().describe("The source the dashboard was computed from."),
  spec: z
    .record(z.string(), z.unknown())
    .describe(
      "A hermetic dashboard spec: { root, elements: { key: { type, props, children } } }. " +
        "Must validate against the component catalog — invalid specs are rejected."
    ),
  title: z.string().describe("Title/question shown with the dashboard."),
};

export async function persistDashboard(
  deps: PersistDashboardDeps,
  args: { source_id: string; spec: Record<string, unknown>; title: string }
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw unknownSource(args.source_id);
  if (source.kind !== "csv") {
    throw new McpToolError(
      "unsupported_source",
      "persist_dashboard currently supports CSV sources (warehouse analyses persist through analyze)."
    );
  }
  assertSourceLive(deps, source);

  const check = deps.validateSpec(args.spec);
  if (!check.success) {
    // The catalog is not yet exposed as an MCP resource, so a bare zod error
    // leaves the host guessing ~90 component names (review S4). Name them.
    const names = deps.catalogComponentNames().join(", ");
    throw new McpToolError(
      "spec_rejected",
      `Spec rejected by catalog validation: ${check.error?.slice(0, 600)}\n\n` +
        `Valid component types: ${names}\n` +
        "Every element needs { type, props, children: [] }. If this is fighting you, " +
        "use analyze instead — it composes a validated dashboard for you."
    );
  }

  // withoutCachedRun: this spec is the HOST's, not a hermetic pipeline run —
  // inheriting the csvId's cached code/artifacts would pair the dashboard with
  // an unrelated run (review S9).
  const persisted = await deps.persistHistoryEntry(source.csvId, args.spec, args.title, {
    withoutCachedRun: true,
  });
  if (!persisted.saved) {
    throw new Error(`Could not persist: ${persisted.reason}`);
  }
  return {
    source_id: source.id,
    history_id: persisted.meta.id,
    dashboard_url: viewUrl(persisted.meta.id),
  };
}

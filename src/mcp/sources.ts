/**
 * Source registry for the MCP harness (mcp-server spec §4, M1).
 *
 * A `source_id` is the ONLY handle tools hand back to the host — never a
 * filesystem path, csvId, or connection config. The registry lives in the
 * shared state slot (survives module-graph splits, same policy as every
 * other in-process store) and holds the live connector for warehouse
 * sources so a session reuses one connection instead of dialing per call.
 *
 * Boundary invariant: nothing stored here is ever serialized into a tool
 * RESPONSE except id/kind/label and schema-derived aggregates.
 */
import { randomUUID } from "node:crypto";
import { stateNamespace } from "@/lib/state-store";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import type { WarehouseConnector } from "@/lib/warehouse/connector";

export interface CsvSource {
  id: string;
  kind: "csv";
  label: string;
  csvId: string;
  schema: CSVSchema;
  /** True for cloud Parquet sources (s3://, https://, gs://) — reads need
   *  network, so run_analysis (network-deny) refuses them; analyze handles
   *  them through the pipeline's scan-budgeted remote path. */
  remote?: boolean;
  /** True for bind-mounted local Parquet file/folder refs — there is no CSV
   *  text in the store, so run_analysis redirects to analyze (whose pipeline
   *  mounts the path into the sandbox). */
  pathBased?: boolean;
}

export interface WarehouseSource {
  id: string;
  kind: "warehouse";
  label: string;
  connectionId: string;
  warehouseType: string;
  connector: WarehouseConnector;
  /** Introspected once at connect; refreshed only by reconnecting. */
  tables: WarehouseTableSchema[];
}

export type McpSource = CsvSource | WarehouseSource;

const sources = () => stateNamespace<McpSource>("mcp-sources");

export function registerSource(
  source: Omit<CsvSource, "id"> | Omit<WarehouseSource, "id">
): McpSource {
  const entry = { ...source, id: randomUUID() } as McpSource;
  sources().set(entry.id, entry);
  return entry;
}

export function getSource(id: string): McpSource | undefined {
  return sources().get(id);
}

export function listSources(): Array<{ id: string; kind: string; label: string }> {
  return [...sources().values()].map((s) => ({ id: s.id, kind: s.kind, label: s.label }));
}

/** Test hook: drop all sources (and close nothing — callers own connectors). */
export function clearSources(): void {
  sources().clear();
}

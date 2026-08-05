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

/**
 * How this source was attached — replayed verbatim in the expiry message so
 * the host can re-attach without guessing (the registry outlives the
 * underlying stores, which expire on a sliding idle TTL).
 */
export type SourceOrigin =
  | { via: "path"; path: string; sheet?: string }
  | { via: "url"; url: string }
  | { via: "connection_id"; connection_id: string };

export function reattachHint(origin: SourceOrigin | undefined): string {
  if (!origin) return "Call connect_source again to re-attach it.";
  if (origin.via === "path") {
    const sheet = origin.sheet ? `, sheet: "${origin.sheet}"` : "";
    return `Re-attach with connect_source({ path: "${origin.path}"${sheet} }).`;
  }
  if (origin.via === "url") return `Re-attach with connect_source({ url: "${origin.url}" }).`;
  return `Re-attach with connect_source({ connection_id: "${origin.connection_id}" }).`;
}

export interface CsvSource {
  id: string;
  kind: "csv";
  label: string;
  origin?: SourceOrigin;
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
  origin?: SourceOrigin;
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

/**
 * What each source can actually be used with (review S1/S2). Without this the
 * host cannot distinguish a local CSV from a cloud URL — both report
 * kind:"csv" — and discovers the difference only by calling a tool and being
 * refused, sometimes pointed at a second tool that also refuses.
 */
export interface SourceCapabilities {
  /** Concrete flavor, not just the storage kind. */
  source_type: "csv" | "cloud-parquet" | "local-parquet" | "warehouse";
  supported_tools: string[];
  /** Tools that will refuse, with the reason — so the host never has to probe. */
  unsupported_tools: Record<string, string>;
}

export function capabilitiesOf(source: McpSource): SourceCapabilities {
  if (source.kind === "warehouse") {
    return {
      source_type: "warehouse",
      supported_tools: ["get_schema", "run_sql", "analyze"],
      unsupported_tools: {
        run_analysis:
          "warehouse data is not materialized locally — use run_sql (pushdown) or analyze",
        persist_dashboard: "host-authored dashboards over warehouse sources are not supported yet",
        verify_narrative:
          "no server-side artifacts for warehouse runs — pass results/chart_data explicitly",
      },
    };
  }
  if (source.remote) {
    return {
      source_type: "cloud-parquet",
      supported_tools: ["get_schema", "analyze", "verify_narrative", "persist_dashboard"],
      unsupported_tools: {
        run_analysis:
          "cloud reads need network; host-authored code runs with networking denied — use analyze",
        run_sql: "run_sql targets warehouse connections — use analyze for cloud Parquet",
      },
    };
  }
  if (source.pathBased) {
    return {
      source_type: "local-parquet",
      supported_tools: ["get_schema", "analyze", "verify_narrative", "persist_dashboard"],
      unsupported_tools: {
        run_analysis: "Parquet is bind-mounted, not loaded as CSV text — use analyze",
        run_sql: "run_sql targets warehouse connections — use analyze for Parquet files",
      },
    };
  }
  return {
    source_type: "csv",
    supported_tools: [
      "get_schema",
      "analyze",
      "run_analysis",
      "verify_narrative",
      "persist_dashboard",
    ],
    unsupported_tools: {
      run_sql: "run_sql targets warehouse connections — use run_analysis or analyze",
    },
  };
}

export function listSources(): Array<Record<string, unknown>> {
  return [...sources().values()].map((s) => ({
    id: s.id,
    kind: s.kind,
    label: s.label,
    ...capabilitiesOf(s),
  }));
}

/** Test hook: drop all sources (and close nothing — callers own connectors). */
export function clearSources(): void {
  sources().clear();
}

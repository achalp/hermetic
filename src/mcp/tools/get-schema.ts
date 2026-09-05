/**
 * get_schema — the rich schema summary for a connected source (mcp-server
 * spec §3, pillar: efficiency).
 *
 * Boundary contract (spec §1 foundational #1): the response is schema and
 * statistics ONLY. Column-level example values (already capped at extraction)
 * are included — they are vocabulary, not records — but row-linked samples
 * (`sample_rows`) are deliberately never exposed; there is no option to
 * include them.
 */
import { z } from "zod";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { ManifestRecord } from "@/lib/manifest/store";
import type { McpDeps } from "../deps";
import { getSource, capabilitiesOf, type McpSource } from "../sources";
import { unknownSource, McpToolError } from "../errors";
import { reattachHint } from "../sources";
import { withToolLog } from "./log";

export const getSchemaInput = {
  source_id: z.string().describe("A source_id returned by connect_source."),
};

const MAX_TABLES = 50;
const MAX_COLUMNS = 80;

function summarizeCsvSchema(schema: CSVSchema) {
  return {
    filename: schema.filename,
    row_count: schema.row_count,
    detected_domain: schema.detected_domain ?? null,
    columns: schema.columns.slice(0, MAX_COLUMNS).map((c) => ({
      name: c.name,
      dtype: c.dtype,
      // ColumnMeta is a discriminated union of aggregates (range/mean,
      // distinct/top values, granularity) — aggregate-only by construction.
      meta: c.meta,
    })),
    column_count: schema.columns.length,
    truncated_columns: Math.max(0, schema.columns.length - MAX_COLUMNS),
    correlations: schema.correlations ?? [],
    has_geojson: schema.has_geojson ?? false,
  };
}

const MAX_ENTITIES = 50;
const MAX_ENTITY_COLUMNS = 40;

/**
 * The manifest summary: the entity index (names, descriptions, hints — what
 * the selection pre-step reads) plus compact columns for READY entities.
 * Pending entities show as pending — analyze materializes what a question
 * needs, so the host never has to drive extraction itself.
 */
export function summarizeManifest(record: ManifestRecord): Record<string, unknown> {
  const entities = [...record.entities.values()];
  return {
    format: record.manifest.format,
    ...(record.manifest.title ? { title: record.manifest.title } : {}),
    ...(record.manifest.description ? { description: record.manifest.description } : {}),
    entity_count: entities.length,
    entities: entities.slice(0, MAX_ENTITIES).map((s) => ({
      name: s.entity.name,
      ...(s.entity.description ? { description: s.entity.description } : {}),
      status: s.status,
      ...(s.rowCount !== undefined
        ? { row_count: s.rowCount, row_count_is_exact: true }
        : s.entity.rowCountHint !== undefined
          ? { row_count: s.entity.rowCountHint, row_count_is_exact: false }
          : {}),
      ...(s.columnCount !== undefined ? { column_count: s.columnCount } : {}),
      ...(s.error ? { error: s.error } : {}),
      ...(s.status === "ready" && s.csvId
        ? {}
        : s.entity.columnDocs?.length
          ? {
              // Pre-introspection vocabulary from the manifest itself.
              column_names: s.entity.columnDocs.slice(0, MAX_ENTITY_COLUMNS).map((c) => c.name),
            }
          : {}),
    })),
    truncated_entities: Math.max(0, entities.length - MAX_ENTITIES),
    excluded_count: record.excluded.length,
    hint:
      "Call analyze with a question — it selects the relevant entities, introspects " +
      "them on demand, and can join across entities in one run.",
  };
}

export function summarizeSource(
  source: McpSource,
  manifestRecord?: ManifestRecord
): Record<string, unknown> {
  // Capabilities travel with EVERY source summary so the host can pick its
  // next tool without probing (review S1/S2).
  const caps = capabilitiesOf(source);
  if (source.kind === "manifest") {
    return {
      kind: "manifest",
      label: source.label,
      ...caps,
      ...(manifestRecord ? summarizeManifest(manifestRecord) : {}),
    };
  }
  if (source.kind === "csv") {
    return {
      kind: "csv",
      label: source.label,
      ...caps,
      schema: summarizeCsvSchema(source.schema),
    };
  }
  // A 66-table warehouse reconnect dumped full per-table columns into the
  // host (and 4x'd sql_gen input). Beyond a small count, columns are
  // per-table detail — return names+rows only and point at get_schema.
  const COMPACT_TABLE_LIMIT = 12;
  if (source.tables.length > COMPACT_TABLE_LIMIT) {
    return {
      kind: "warehouse",
      label: source.label,
      ...caps,
      table_count: source.tables.length,
      tables: source.tables.slice(0, MAX_TABLES).map((t) => ({
        schema: t.schema,
        name: t.name,
        rows: t.row_count_estimate ?? null,
      })),
      note: `column details omitted for ${source.tables.length} tables — call get_schema with a table name`,
    };
  }
  const tables = source.tables.slice(0, MAX_TABLES).map((t) => ({
    schema: t.schema,
    name: t.name,
    row_count_estimate: t.row_count_estimate ?? null,
    columns: t.columns.slice(0, MAX_COLUMNS).map((c) => ({ name: c.name, type: c.type })),
    column_count: t.columns.length,
    truncated_columns: Math.max(0, t.columns.length - MAX_COLUMNS),
  }));
  return {
    kind: "warehouse",
    label: source.label,
    ...caps,
    warehouse_type: source.warehouseType,
    table_count: source.tables.length,
    tables,
    truncated_tables: Math.max(0, source.tables.length - MAX_TABLES),
  };
}

/** The McpDeps slice get_schema needs (manifest sources read the live record). */
export type GetSchemaDeps = Pick<McpDeps, "getManifestRecord">;

export async function getSchema(
  deps: GetSchemaDeps,
  args: { source_id: string }
): Promise<Record<string, unknown>> {
  return withToolLog("get_schema", { source_id: args.source_id }, async () => {
    const source = getSource(args.source_id);
    if (!source) throw unknownSource(args.source_id);
    if (source.kind === "manifest") {
      const record = deps.getManifestRecord?.(source.manifestId);
      if (!record) {
        throw new McpToolError(
          "source_expired",
          `The manifest "${source.label}" is no longer in hermetic's store (the server ` +
            `restarted since it was attached). ${reattachHint(source.origin)}`
        );
      }
      return { source_id: source.id, ...summarizeSource(source, record) };
    }
    return { source_id: source.id, ...summarizeSource(source) };
  });
}

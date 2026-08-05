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
import { getSource, capabilitiesOf, type McpSource } from "../sources";

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
    correlations: schema.correlations ?? [],
    has_geojson: schema.has_geojson ?? false,
  };
}

export function summarizeSource(source: McpSource): Record<string, unknown> {
  // Capabilities travel with EVERY source summary so the host can pick its
  // next tool without probing (review S1/S2).
  const caps = capabilitiesOf(source);
  if (source.kind === "csv") {
    return {
      kind: "csv",
      label: source.label,
      ...caps,
      schema: summarizeCsvSchema(source.schema),
    };
  }
  const tables = source.tables.slice(0, MAX_TABLES).map((t) => ({
    schema: t.schema,
    name: t.name,
    row_count_estimate: t.row_count_estimate ?? null,
    columns: t.columns.slice(0, MAX_COLUMNS).map((c) => ({ name: c.name, type: c.type })),
    column_count: t.columns.length,
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

export async function getSchema(args: { source_id: string }): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw new Error(`Unknown source_id '${args.source_id}'. Call connect_source first.`);
  return { source_id: source.id, ...summarizeSource(source) };
}

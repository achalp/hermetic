/**
 * Pure derivations from the loaded schema / warehouse summary that feed the
 * data rail, composer chip, and top-bar source pill (extracted from page.tsx,
 * exit audit F1).
 */
import type { CSVSchema } from "@/lib/contracts/data-schema";

export interface WarehouseSummary {
  isConnected: boolean;
  warehouseType: string | null;
  tableCount: number;
  totalColumns: number;
}

/** Profile strip items from schema or warehouse. */
export function buildProfileItems(schema: CSVSchema | null, wh: WarehouseSummary): string[] {
  const items: string[] = [];
  if (schema) {
    items.push(`${schema.row_count.toLocaleString()} rows`);
    items.push(`${schema.columns.length} columns`);
    if (schema.columns.length > 0) {
      const colNames = schema.columns.slice(0, 4).map((c) => c.name);
      if (schema.columns.length > 4) colNames.push(`+${schema.columns.length - 4} more`);
      items.push(colNames.join(" · "));
    }
  } else if (wh.isConnected) {
    items.push(`${wh.tableCount} tables`);
    items.push(`${wh.totalColumns} columns`);
  }
  return items;
}

/** Composer data-chip label — the attached dataset/connection, State 2+. */
/**
 * A connected dataset-manifest catalog, summarized for source labels. When
 * present it WINS over the active entity's schema: a manifest question is
 * scoped per-ask by the selection pre-step over the WHOLE catalog (any table,
 * up to 6 combined), so labelling the source with the currently-previewed
 * table read as a scope that never existed — the active entity is a schema
 * PREVIEW, exactly like browsing one warehouse table.
 */
export interface ManifestSummary {
  title?: string | null;
  entityCount: number;
}

export function buildDatasetLabel(
  schema: CSVSchema | null,
  wh: WarehouseSummary,
  manifest?: ManifestSummary | null
): string | null {
  if (manifest) {
    return `${manifest.title ?? "Dataset catalog"} · ask across ${manifest.entityCount} tables`;
  }
  return schema
    ? (schema.filename ?? "Uploaded data")
    : wh.isConnected
      ? `${wh.warehouseType ?? "Warehouse"} · ${wh.tableCount} tables`
      : null;
}

/** Source label for the top-bar pill. */
export function buildSourceLabel(
  schema: CSVSchema | null,
  wh: WarehouseSummary,
  manifest?: ManifestSummary | null
): string {
  if (manifest) {
    return `✓ ${manifest.title ?? "Dataset catalog"} · ${manifest.entityCount} tables`;
  }
  return schema
    ? `✓ ${schema.filename ?? "data"} · ${schema.row_count.toLocaleString()} rows · ${schema.columns.length} columns`
    : wh.isConnected
      ? `✓ ${wh.warehouseType ?? "Warehouse"} · ${wh.tableCount} tables · ${wh.totalColumns} columns`
      : "";
}

function mapSchemaCol(c: { name: string; dtype: string; sample_values?: string[] }) {
  return {
    name: c.name,
    type: c.dtype === "number" ? "number" : c.dtype === "date" ? "date" : "text",
    sample: c.sample_values?.[0] ?? "",
  };
}

/** Data-rail schema views: first 8 columns, the full list, and the overflow. */
export function buildRailSchemas(schema: CSVSchema | null) {
  return {
    railSchema: schema?.columns.slice(0, 8).map(mapSchemaCol),
    railAllSchema: schema?.columns.map(mapSchemaCol),
    railMoreColumns: schema ? Math.max(0, schema.columns.length - 8) : 0,
  };
}

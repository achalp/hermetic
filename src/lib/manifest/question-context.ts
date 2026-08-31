/**
 * Multi-entity manifest questions — the ONE module both pipelines use (spec §7;
 * author directive: ask and investigate "must stay at par", so this is shared
 * the way validate-request.ts is — a single implementation neither can drift
 * from).
 *
 * ── Trust ──
 * The request carries IDS, never data: entity names + csvIds picked client-side
 * after the selection pre-step. `resolveManifestQuestion` re-validates every id
 * server-side — the manifest must exist, each name must be one of ITS entities,
 * each csvId must be the id the server itself registered for that entity, and
 * the primary must equal the request's csv_id. A hostile client can therefore
 * only ask about entities it was already granted, in combinations the server
 * already knows.
 *
 * ── Delivery ──
 * Docker: nothing to deliver — generated DuckDB reads each entity's URL
 * directly; all entities share one host (the same-host gate ran at connect), so
 * the PRIMARY's egress grant covers every read.
 * WASM: the primary rides the existing path (/data/input.csv); each ADDITIONAL
 * entity is materialized host-side and delivered like a workbook sheet at
 * /data/entities/<name>.csv (spec §7.4 — one delivery mechanism, not two).
 */
import type { CSVSchema, SheetInfo } from "@/lib/contracts/data-schema";
import type { StoredCSV } from "@/lib/contracts/storage-types";
import { getManifestStore } from "./store";
import { ManifestError } from "./shared";
import { getStoredCSV } from "@/lib/csv/storage";
import { detectRelationships } from "@/lib/excel/relationships";
import { formatColumnMeta } from "@/lib/llm/prompts";
import { parquetReadExpr } from "@/lib/parquet/duckdb-source";

export interface ManifestQuestionRequest {
  manifest_id: string;
  entities: { name: string; csv_id: string }[];
}

export interface ResolvedManifestEntity {
  name: string;
  csvId: string;
  stored: StoredCSV;
}

export interface ResolvedManifestQuestion {
  manifestId: string;
  /** Primary first — the entity whose csvId drives the pipeline's plumbing. */
  entities: ResolvedManifestEntity[];
}

export function resolveManifestQuestion(
  req: ManifestQuestionRequest,
  requestCsvId: string | undefined
): ResolvedManifestQuestion {
  const record = getManifestStore().get(req.manifest_id);
  if (!record) throw new ManifestError("Unknown manifest — reconnect the source and retry.");

  const entities: ResolvedManifestEntity[] = req.entities.map(({ name, csv_id }) => {
    const state = record.entities.get(name);
    if (!state) throw new ManifestError(`Unknown manifest entity "${name}".`);
    if (state.csvId !== csv_id) {
      // The server's OWN registration is authoritative — a mismatched id means a
      // stale client (entity re-extracted) or a forgery; both re-prepare.
      throw new ManifestError(`Entity "${name}" is out of date — re-ask the question.`);
    }
    const stored = getStoredCSV(csv_id);
    if (!stored?.remoteParquetUrl) {
      throw new ManifestError(`Entity "${name}" is no longer loaded — re-ask the question.`);
    }
    return { name, csvId: csv_id, stored };
  });

  if (requestCsvId && entities[0]!.csvId !== requestCsvId) {
    throw new ManifestError("The primary entity must match the request's csv_id.");
  }
  return { manifestId: req.manifest_id, entities };
}

/** Where each entity's data lives, per runtime. */
export type ManifestDelivery = { kind: "docker" } | { kind: "wasm"; paths: Map<string, string> }; // name → /data/... path

/**
 * The Data Location + schema section for a multi-entity question — the
 * workbook-context shape (the proven multi-entity mechanism), with remote
 * wording. Rendered from the SAME per-entity CSVSchemas the entity browser
 * shows, in metadata mode.
 */
export function buildManifestQuestionContext(
  resolved: ResolvedManifestQuestion,
  delivery: ManifestDelivery
): string {
  const lines: string[] = [];
  lines.push(
    `This question uses ${resolved.entities.length} entities from one dataset manifest. ` +
      `Read each entity from EXACTLY the location given below.`
  );
  lines.push("");
  lines.push("### Entity locations");
  for (const e of resolved.entities) {
    if (delivery.kind === "docker") {
      const expr = parquetReadExpr(e.stored.remoteParquetUrl!, Boolean(e.stored.isHivePartitioned));
      lines.push(`- "${e.name}" → duckdb.sql(f"SELECT ... FROM ${expr}")`);
    } else {
      lines.push(`- "${e.name}" → pd.read_csv("${delivery.paths.get(e.name)}")`);
    }
  }
  lines.push("");
  for (const e of resolved.entities) {
    const schema = e.stored.schema;
    lines.push(`### Entity: ${e.name} (${schema.row_count.toLocaleString()} rows)`);
    lines.push("Columns:");
    for (const col of schema.columns) lines.push(formatColumnMeta(col));
    lines.push("");
  }

  const relationships = detectRelationships(resolved.entities.map((e) => toSheetInfo(e)));
  if (relationships.length > 0) {
    lines.push("### Detected relationships (join hints)");
    for (const rel of relationships) {
      if (rel.confidence < 0.5) continue;
      lines.push(
        `- ${rel.sourceSheet}.${rel.sourceColumn} ↔ ${rel.targetSheet}.${rel.targetColumn}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Adapt an entity's CSVSchema to the relationship detector's SheetInfo shape. */
function toSheetInfo(e: ResolvedManifestEntity): SheetInfo {
  const schema: CSVSchema = e.stored.schema;
  return {
    name: e.name,
    rowCount: schema.row_count,
    columnCount: schema.columns.length,
    headers: schema.columns.map((c) => c.name),
    sampleRows: schema.sample_rows
      .slice(0, 5)
      .map((row) => schema.columns.map((c) => String(row[c.name] ?? ""))),
  };
}

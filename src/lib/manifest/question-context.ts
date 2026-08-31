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
  /** Object size from the manifest (bytesHint) — sizes the token budget and the
   *  footer prefetch without an extra probe. Absent when the manifest had none. */
  bytesHint?: number;
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
    return {
      name,
      csvId: csv_id,
      stored,
      ...(state.entity.bytesHint !== undefined ? { bytesHint: state.entity.bytesHint } : {}),
    };
  });

  if (requestCsvId && entities[0]!.csvId !== requestCsvId) {
    throw new ManifestError("The primary entity must match the request's csv_id.");
  }
  return { manifestId: req.manifest_id, entities };
}

/** Where each entity's data lives, per runtime. */
export type ManifestDelivery =
  | { kind: "docker" }
  /** Materialized CSVs (the P2 shape — kept for tests/fallback wording). */
  | { kind: "wasm"; paths: Map<string, string> } // name → /data/... path
  /** D40: range-token aliases — DuckDB in the worker reads row groups on demand.
   *  No materialization, no size ceilings; readExprs maps entity → read expr. */
  | { kind: "wasm-ranged"; readExprs: Map<string, string> };

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
    } else if (delivery.kind === "wasm-ranged") {
      lines.push(
        `- "${e.name}" → duckdb.sql(f"SELECT ... FROM ${delivery.readExprs.get(e.name)}")`
      );
    } else {
      lines.push(`- "${e.name}" → pd.read_csv("${delivery.paths.get(e.name)}")`);
    }
  }
  if (delivery.kind === "wasm-ranged") {
    lines.push("");
    lines.push(
      "These are registered DuckDB files read by byte range — use `import duckdb` and " +
        "the exact expressions above (SQL-first; convert to pandas with .df() only " +
        "AFTER aggregating/filtering). Do NOT use pd.read_csv or any URL for them."
    );
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

// ── D40: range-token aliases for a wasm multi-entity QUESTION ────────────────

import type { PrefetchTarget } from "@/lib/sandbox/wasm/footer-prefetch";
import { getRangeRegistry } from "@/lib/sandbox/wasm/range-singleton";
import { enumerateRemoteParquetFiles, resolveRemoteHttpsFetch } from "@/lib/sandbox/remote-fetch";
import { deriveAllowedEgressHosts } from "@/lib/sandbox/egress";
import {
  buildHiveAliases,
  buildHiveReadExpr,
  budgetForFile,
  encodeS3Key,
} from "@/lib/sandbox/wasm/remote-hive";

/**
 * Token budget for a SINGLE-object entity in a question (not just a profile):
 * generated code may scan every row group of the columns it needs, possibly
 * twice (retry within the run re-reads) — so 2× the manifest's size hint,
 * floored generously. Without a hint, the same fixed ceiling the extraction
 * path uses. A budget is a runaway bound, not a fairness meter (D20).
 */
export function questionBudgetFor(bytesHint: number | undefined): number {
  const FLOOR = 64 * 1024 * 1024;
  const NO_HINT = 512 * 1024 * 1024;
  return bytesHint === undefined ? NO_HINT : Math.max(FLOOR, 2 * bytesHint);
}

export interface ManifestWasmAliases {
  /** Every registered alias, across all entities — feeds request.duckdb. */
  aliases: { name: string; url: string }[];
  /** Per-entity read expression for the prompt context. */
  readExprs: Map<string, string>;
  /** Footer-prefetch targets (only where a size is known — hint or listing). */
  prefetch: PrefetchTarget[];
}

/**
 * Mint run-scoped range tokens for every selected entity (D40 — item 1+2 of the
 * P3 review): a single-object entity gets ONE token; a hive/glob entity is
 * enumerated and gets one token PER FILE (the D21 fan-out — the worker picks
 * offsets, never destinations; per-file tokens keep that invariant). This is
 * what removes the P2 materialization ceilings: nothing is downloaded ahead of
 * time, DuckDB reads only the row groups the question touches.
 */
export async function buildManifestWasmAliases(
  resolved: ResolvedManifestQuestion,
  runId: string | undefined,
  opts: { signal?: AbortSignal; budgetMultiplier?: number } = {}
): Promise<ManifestWasmAliases> {
  // Investigate passes >1: every sub-step boots a fresh worker but reads through
  // the SAME run-scoped tokens, so a single-question budget would starve later
  // steps into 509s. ×4 covers the typical step count; exhaustion still fails
  // loudly (a budget is a runaway bound, not a meter — D20).
  const mult = Math.max(1, opts.budgetMultiplier ?? 1);
  const registry = getRangeRegistry();
  const aliases: { name: string; url: string }[] = [];
  const readExprs = new Map<string, string>();
  const prefetch: PrefetchTarget[] = [];

  for (const e of resolved.entities) {
    const stored = e.stored;
    const url = stored.remoteParquetUrl!;
    const isMulti = Boolean(stored.isHivePartitioned) || url.includes("*");
    if (isMulti) {
      const { host, objects } = await enumerateRemoteParquetFiles(stored, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const allowlist = deriveAllowedEgressHosts(url, stored.remoteCreds);
      const fileAliases = buildHiveAliases(objects, host, (fileUrl, sizeBytes) =>
        registry.register({
          url: fileUrl,
          allowlist,
          ...(runId ? { runId } : {}),
          budgetBytes: mult * budgetForFile(sizeBytes),
        })
      );
      aliases.push(...fileAliases);
      readExprs.set(e.name, buildHiveReadExpr(fileAliases, Boolean(stored.isHivePartitioned)));
      prefetch.push(
        ...objects.map((o) => ({
          url: `https://${host}/${encodeS3Key(o.key)}`,
          allowlist,
          sizeBytes: o.size,
        }))
      );
    } else {
      const plan = await resolveRemoteHttpsFetch(stored);
      if (!plan.ok) {
        throw new ManifestError(`Cannot read entity "${e.name}": ${plan.unsupported}`);
      }
      const token = registry.register({
        url: plan.url,
        allowlist: plan.allowlist,
        ...(runId ? { runId } : {}),
        budgetBytes: mult * questionBudgetFor(e.bytesHint),
      });
      // The alias keeps a .parquet suffix so the file is self-describing in SQL
      // and in error messages; entity names are unique within a manifest (P0).
      const aliasName = `${e.name}.parquet`;
      aliases.push({ name: aliasName, url: `/api/wasm-range/${token}` });
      readExprs.set(e.name, `read_parquet('${aliasName}')`);
      if (e.bytesHint !== undefined) {
        prefetch.push({ url: plan.url, allowlist: plan.allowlist, sizeBytes: e.bytesHint });
      }
    }
  }
  return { aliases, readExprs, prefetch };
}

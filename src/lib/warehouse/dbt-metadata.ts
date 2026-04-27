/**
 * dbt metadata loader.
 *
 * Reads a dbt project's `manifest.json` (produced by `dbt docs generate`)
 * and indexes table + column descriptions by `database.schema.name`. The
 * resulting metadata is merged into `WarehouseTableSchema` to enrich the
 * LLM SQL-generation prompt.
 *
 * dbt manifest schema reference:
 * https://schemas.getdbt.com/dbt/manifest/v11.json
 *
 * We parse defensively — missing fields are treated as empty, unknown
 * resource_types are ignored. Pinned to manifest schema versions v10 and
 * v11; logs a warning otherwise but still attempts to parse.
 *
 * Deliberately scoped to file-based manifests for v1. dbt Cloud API
 * authentication is out of scope.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/logger";

/** Minimal shape of a dbt manifest node we care about (model, source, seed, snapshot). */
interface DbtNode {
  resource_type?: string;
  name?: string;
  database?: string | null;
  schema?: string | null;
  description?: string;
  columns?: Record<string, { name?: string; description?: string }>;
  /** Sources have `identifier` instead of `name` for the actual table name */
  identifier?: string;
}

interface DbtManifest {
  metadata?: { dbt_schema_version?: string };
  nodes?: Record<string, DbtNode>;
  sources?: Record<string, DbtNode>;
}

export interface DbtTableMeta {
  /** Description from dbt docs (table-level). */
  description?: string;
  /** Map of column name → description. */
  column_descriptions: Record<string, string>;
}

export interface DbtMetadataIndex {
  /** Map of `db.schema.name` (lowercased) → metadata. */
  byKey: Map<string, DbtTableMeta>;
  /** Map of `schema.name` (lowercased) → metadata, for sources without database. */
  bySchemaName: Map<string, DbtTableMeta>;
  /** Number of model + source nodes indexed. */
  modelCount: number;
  /** dbt schema version observed in the manifest, e.g. "v10" / "v11". */
  schemaVersion?: string;
  /** mtime of the manifest at parse time (epoch ms) — used for invalidation. */
  manifestMtimeMs: number;
}

/** Cache of parsed manifests. Key: absolute file path. */
const manifestCache = new Map<string, { index: DbtMetadataIndex; mtimeMs: number }>();

const SUPPORTED_SCHEMA_VERSIONS = [
  "https://schemas.getdbt.com/dbt/manifest/v10.json",
  "https://schemas.getdbt.com/dbt/manifest/v11.json",
];

const COVERED_RESOURCE_TYPES = new Set(["model", "source", "seed", "snapshot"]);

/**
 * Validate a path looks like a real `manifest.json`. Used by the API
 * endpoint to reject random files before parsing.
 */
export async function validateManifestPath(
  filePath: string
): Promise<{ ok: boolean; error?: string }> {
  if (!filePath || typeof filePath !== "string") {
    return { ok: false, error: "Path is required" };
  }
  if (path.basename(filePath) !== "manifest.json") {
    return { ok: false, error: "Path must point to a file named manifest.json" };
  }
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { ok: false, error: "Path is not a file" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

function indexNode(
  node: DbtNode,
  byKey: Map<string, DbtTableMeta>,
  bySchemaName: Map<string, DbtTableMeta>
): boolean {
  if (!node.resource_type || !COVERED_RESOURCE_TYPES.has(node.resource_type)) return false;

  const tableName = (node.identifier ?? node.name ?? "").toLowerCase();
  if (!tableName) return false;

  const schemaName = (node.schema ?? "").toLowerCase();
  const dbName = (node.database ?? "").toLowerCase();

  const colDescs: Record<string, string> = {};
  if (node.columns) {
    for (const [colName, colDef] of Object.entries(node.columns)) {
      if (colDef?.description) colDescs[colName.toLowerCase()] = colDef.description;
    }
  }

  const meta: DbtTableMeta = {
    description: node.description?.trim() || undefined,
    column_descriptions: colDescs,
  };

  if (dbName) byKey.set(`${dbName}.${schemaName}.${tableName}`, meta);
  if (schemaName) bySchemaName.set(`${schemaName}.${tableName}`, meta);
  return true;
}

/**
 * Parse and index a dbt manifest. Caches by path + mtime; subsequent calls
 * with the same unchanged file return the cached index instantly.
 */
export async function loadDbtManifest(filePath: string): Promise<DbtMetadataIndex> {
  const absPath = path.resolve(filePath);

  // mtime check for cache invalidation
  let mtimeMs: number;
  try {
    const info = await stat(absPath);
    mtimeMs = info.mtimeMs;
  } catch (err) {
    throw new Error(
      `Cannot access dbt manifest at ${absPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const cached = manifestCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.index;
  }

  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Cannot read dbt manifest: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let manifest: DbtManifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `dbt manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const schemaUrl = manifest.metadata?.dbt_schema_version;
  if (schemaUrl && !SUPPORTED_SCHEMA_VERSIONS.includes(schemaUrl)) {
    logger.warn("Unsupported dbt manifest schema version (parsing anyway)", { schemaUrl });
  }

  const byKey = new Map<string, DbtTableMeta>();
  const bySchemaName = new Map<string, DbtTableMeta>();
  let modelCount = 0;

  if (manifest.nodes && typeof manifest.nodes === "object") {
    for (const node of Object.values(manifest.nodes)) {
      if (indexNode(node, byKey, bySchemaName)) modelCount++;
    }
  }
  if (manifest.sources && typeof manifest.sources === "object") {
    for (const node of Object.values(manifest.sources)) {
      // Sources always have resource_type "source" — set it if missing
      const withType = node.resource_type ? node : { ...node, resource_type: "source" };
      if (indexNode(withType, byKey, bySchemaName)) modelCount++;
    }
  }

  const versionTag = schemaUrl?.match(/manifest\/(v\d+)\.json/)?.[1];

  const index: DbtMetadataIndex = {
    byKey,
    bySchemaName,
    modelCount,
    schemaVersion: versionTag,
    manifestMtimeMs: mtimeMs,
  };

  manifestCache.set(absPath, { index, mtimeMs });
  logger.info("Loaded dbt manifest", { path: absPath, modelCount, schemaVersion: versionTag });
  return index;
}

/** Drop the cached parse for a given manifest path. */
export function clearDbtManifestCache(filePath?: string): void {
  if (filePath) {
    manifestCache.delete(path.resolve(filePath));
  } else {
    manifestCache.clear();
  }
}

/**
 * Look up metadata for a single table. Tries `db.schema.name` first, falls
 * back to `schema.name` when database is not in the index.
 */
export function lookupTableMeta(
  index: DbtMetadataIndex,
  database: string | undefined,
  schema: string,
  name: string
): DbtTableMeta | undefined {
  const dbLower = (database ?? "").toLowerCase();
  const schemaLower = schema.toLowerCase();
  const nameLower = name.toLowerCase();
  if (dbLower) {
    const byFull = index.byKey.get(`${dbLower}.${schemaLower}.${nameLower}`);
    if (byFull) return byFull;
  }
  return index.bySchemaName.get(`${schemaLower}.${nameLower}`);
}

/**
 * Apply dbt metadata to a list of warehouse table schemas in-place. Fills
 * `description` on tables and on individual columns when a match exists.
 * Returns the count of tables enriched (for logging / UI badges).
 */
export function applyDbtMetadata(
  schemas: import("@/lib/types").WarehouseTableSchema[],
  index: DbtMetadataIndex,
  /** Database name from the warehouse connection (Postgres "database", BigQuery "project", etc.) */
  database?: string
): number {
  let enriched = 0;
  for (const table of schemas) {
    // For Trino, schema field is "catalog.schema" — use the last part for matching
    const lastSchemaPart = table.schema.includes(".")
      ? table.schema.split(".").slice(-1)[0]
      : table.schema;
    const meta = lookupTableMeta(index, database, lastSchemaPart, table.name);
    if (!meta) continue;
    enriched++;
    if (meta.description && !table.description) {
      table.description = meta.description;
    }
    for (const col of table.columns) {
      const desc = meta.column_descriptions[col.name.toLowerCase()];
      if (desc && !col.description) col.description = desc;
    }
  }
  return enriched;
}

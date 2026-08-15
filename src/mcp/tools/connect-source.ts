/**
 * connect_source — attach a data source and return a source_id + schema
 * summary (mcp-server spec §3, pillar: boundary).
 *
 * One of:
 *   path          — local CSV, Excel (.xlsx), GeoJSON (.geojson/.json),
 *                   Parquet file, or Parquet folder (Hive partitioning
 *                   auto-detected). Excel with multiple sheets returns the
 *                   sheet list; re-call with `sheet` to pick one.
 *   url           — cloud Parquet (s3://, https://, gs://): file, folder, or
 *                   Hive-partitioned prefix, read over the network by DuckDB.
 *   connection_id — saved warehouse connection (created in the hermetic app).
 *
 * The `path` branch is the shared ingestion pipeline (lib/sources/ingest.ts)
 * — the SAME dispatch/parse/validate/store the web upload and local-files
 * routes use, so MCP sources get large-CSV Parquet materialization,
 * warm-sandbox prep, and Recents recording too. The `connection_id` branch
 * uses the shared cached introspection (lib/warehouse/introspect.ts), so
 * reconnects hit the schema cache and tables carry inferred relationships,
 * identical to the web connect route.
 *
 * The response never carries credentials, raw rows, or file contents — only
 * the id, label, and the same schema summary get_schema returns.
 *
 * Credentials are NEVER tool arguments (a secret passed as an arg transits
 * the host model's context): cloud buckets authenticate via the MCP server's
 * own environment (AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 * AWS_ENDPOINT_URL in the host's mcpServers env block); warehouses via
 * connections saved once in the web app. That policy is also why there is no
 * "new warehouse connection" input here.
 */
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ingestFromDeps, type McpDeps } from "../deps";
import { registerSource, type McpSource } from "../sources";
import { persistSources } from "../source-persist";
import { McpToolError } from "../errors";
import { summarizeSource } from "./get-schema";
import { withToolLog } from "./log";
import { IngestError, type IngestResult } from "@/lib/sources/ingest";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseTableInfo, WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";

export const connectSourceInput = {
  path: z
    .string()
    .optional()
    .describe(
      "Path to a local data file or Parquet folder: .csv, .xlsx, .geojson/.json (GeoJSON), " +
        ".parquet, or a directory of Parquet files (Hive partitioning auto-detected)."
    ),
  url: z
    .string()
    .optional()
    .describe(
      "Cloud Parquet URL (s3://, https://, gs://): a file, folder, or Hive-partitioned " +
        "prefix. Read over the network — nothing is downloaded. Private buckets use the " +
        "server's AWS_* environment, never tool arguments."
    ),
  connection_id: z
    .string()
    .optional()
    .describe("Id of a saved warehouse connection (created in the hermetic app)."),
  sheet: z
    .string()
    .optional()
    .describe("For multi-sheet Excel files: the sheet to load. Omit to get the sheet list back."),
  label: z.string().optional().describe("Optional display label for the source."),
};

/** Private-bucket auth from the SERVER environment (never tool args). */
export function envRemoteCreds(env: NodeJS.ProcessEnv = process.env): RemoteCreds | undefined {
  const creds: RemoteCreds = {};
  if (env.AWS_REGION) creds.s3Region = env.AWS_REGION;
  if (env.AWS_ACCESS_KEY_ID) creds.s3AccessKeyId = env.AWS_ACCESS_KEY_ID;
  if (env.AWS_SECRET_ACCESS_KEY) creds.s3SecretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (env.AWS_ENDPOINT_URL) creds.s3Endpoint = env.AWS_ENDPOINT_URL;
  return Object.keys(creds).length > 0 ? creds : undefined;
}

/** A human filename from a Parquet URL: the last path segment, or the host. */
function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^s3:\/\//i, "https://").replace(/^gs:\/\//i, "https://"));
    return u.pathname.split("/").filter(Boolean).pop() || u.hostname;
  } catch {
    return url.split("/").filter(Boolean).pop() || url;
  }
}

async function connectUrl(deps: McpDeps, url: string, label?: string): Promise<McpSource> {
  if (!deps.isSafeParquetUrl(url)) {
    throw new McpToolError(
      "invalid_input",
      "Not a valid cloud Parquet URL — expected s3://, https://, or gs:// with no quotes " +
        "or shell characters."
    );
  }
  const { readUrl, isHivePartitioned } = deps.normalizeRemoteParquetUrl(url);
  const csvId = randomUUID();
  const filename = filenameFromUrl(url);
  const creds = envRemoteCreds();
  const schema = await deps.extractRemoteParquetSchema(
    readUrl,
    csvId,
    filename,
    deps.getActiveSandboxRuntime(),
    isHivePartitioned,
    creds
  );
  deps.storeRemoteParquetRef(csvId, schema, readUrl, creds, isHivePartitioned);
  return registerSource({
    kind: "csv",
    label: label ?? filename,
    csvId,
    schema,
    remote: true,
    origin: { via: "url", url },
  });
}

async function connectPath(
  deps: McpDeps,
  abs: string,
  sheet: string | undefined,
  label: string | undefined
): Promise<McpSource | Record<string, unknown>> {
  let result: IngestResult;
  try {
    result = await ingestFromDeps(deps)(
      { path: abs, sheet },
      // MCP opts into the web routes' conveniences: large-CSV Parquet
      // materialization (docker-only — the same gate the upload route uses,
      // enforced inside ingest), warm-sandbox prep (cheap: fire-and-forget,
      // it only pre-loads data into an already-managed warm container so
      // analyze/run_analysis start faster), and Recents recording (the same
      // "re-open in one click" value the web Recents list gets —
      // list_sources-adjacent).
      { materializeLargeCsv: true, warmSandbox: true, recordRecent: true }
    );
  } catch (err) {
    // Ingest raises plain, actionable IngestErrors; the mapping into the MCP
    // error taxonomy (src/mcp/errors.ts) lives at THIS boundary.
    if (err instanceof IngestError) throw new McpToolError("invalid_input", err.message);
    throw err;
  }

  if (result.kind === "sheet_picker") {
    return {
      needs_sheet: true,
      path: abs,
      sheets: result.sheets.map((sh) => ({
        name: sh.name,
        row_count: sh.rowCount,
        column_count: sh.columnCount,
      })),
      hint: "Multiple sheets — call connect_source again with the same path and a `sheet`.",
    };
  }

  return registerSource({
    kind: "csv",
    label: label ?? result.schema.filename,
    csvId: result.csvId,
    schema: result.schema,
    // Parquet refs AND materialized large CSVs are bind-mounted, not stored
    // CSV text — run_analysis redirects those to analyze.
    pathBased: result.pathBased || undefined,
    origin: { via: "path", path: abs, sheet: result.sheet },
  });
}

async function connectWarehouse(
  deps: McpDeps,
  connectionId: string,
  label: string | undefined
): Promise<McpSource> {
  const connections = await deps.loadConnections();
  const saved = connections.find((c) => c.id === connectionId);
  if (!saved) {
    const known = connections.map((c) => c.id).join(", ") || "(none)";
    throw new McpToolError(
      "invalid_input",
      `No saved connection '${connectionId}'. Known ids: ${known}`
    );
  }
  const connector = deps.createConnector(saved.config);
  await connector.testConnection();

  // Cached, relationship-enriched introspection — the SAME path the web
  // connect route uses (lib/warehouse/introspect.ts): schema-cache keyed by
  // warehouseSourceKey, fingerprint-gated on the cheap table listing, with
  // inferRelationships baked into the cached artifact. The raw fallback
  // serves fake-deps suites that predate the seam.
  let tableInfos: WarehouseTableInfo[];
  let tableSchemas: WarehouseTableSchema[];
  if (deps.introspectWithCache) {
    ({ tables: tableInfos, tableSchemas } = await deps.introspectWithCache(
      connector,
      saved.config
    ));
  } else {
    tableSchemas = await connector.introspectAllTables();
    tableInfos = await connector.listTables();
  }

  // Flatten per-table FKs (native + inferred) into one join list — on the
  // source so get_schema can surface it, and on the connect response now.
  const relationships = tableSchemas.flatMap((t) =>
    (t.foreign_keys ?? []).map((fk) => ({ table: t.name, ...fk }))
  );

  const source = registerSource({
    kind: "warehouse",
    label: label ?? saved.name ?? saved.label,
    connectionId: saved.id,
    warehouseType: saved.config.type,
    connector,
    tables: tableSchemas,
    relationships: relationships.length > 0 ? relationships : undefined,
    origin: { via: "connection_id", connection_id: saved.id },
  });
  // Also register in the shared warehouse store under the source id, so
  // analyze() can hand runAskQuery the same {warehouse, connector} state
  // the web harness assembles (validate-request.ts).
  deps.storeWarehouse(
    {
      warehouseId: source.id,
      config: saved.config,
      tables: tableInfos,
      tableSchemas,
      createdAt: Date.now(),
    },
    connector
  );
  return source;
}

export async function connectSource(
  deps: McpDeps,
  args: { path?: string; url?: string; connection_id?: string; sheet?: string; label?: string }
): Promise<Record<string, unknown>> {
  // `via` (not the raw url — it can embed a signed query) identifies the branch.
  const via = args.url ? "url" : args.path ? "path" : args.connection_id ? "connection_id" : "none";
  return withToolLog(
    "connect_source",
    { via, path: args.path, connection_id: args.connection_id },
    () => connectSourceImpl(deps, args)
  );
}

async function connectSourceImpl(
  deps: McpDeps,
  args: { path?: string; url?: string; connection_id?: string; sheet?: string; label?: string }
): Promise<Record<string, unknown>> {
  const given = [args.path, args.url, args.connection_id].filter(Boolean).length;
  if (given !== 1) {
    throw new McpToolError(
      "invalid_input",
      "Provide exactly one of `path`, `url`, or `connection_id`."
    );
  }

  if (args.sheet && !(args.path ?? "").toLowerCase().endsWith(".xlsx")) {
    throw new McpToolError(
      "invalid_input",
      "`sheet` applies only to .xlsx paths — remove it or point `path` at a workbook."
    );
  }

  let source: McpSource;
  if (args.url) {
    source = await connectUrl(deps, args.url.trim(), args.label);
  } else if (args.path) {
    const connected = await connectPath(deps, resolve(args.path), args.sheet, args.label);
    if ("needs_sheet" in connected) return connected as Record<string, unknown>;
    source = connected as McpSource;
  } else {
    source = await connectWarehouse(deps, args.connection_id!, args.label);
  }

  // Write-through registry persistence: hosts (Claude Desktop chat) recycle
  // this server between turns; without this, every recycle invalidates the
  // source_id the host still holds. Best-effort — never fails the connect.
  if (source.kind === "csv") void persistSources(deps);

  const summary: Record<string, unknown> = { source_id: source.id, ...summarizeSource(source) };
  // Additive: the join graph rides the connect response too, so a host can
  // plan SQL without a second call.
  if (source.kind === "warehouse" && source.relationships) {
    summary.relationships = source.relationships;
  }
  return summary;
}

export type { CSVSchema };

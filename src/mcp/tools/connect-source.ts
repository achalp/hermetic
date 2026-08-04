/**
 * connect_source — attach a data source and return a source_id + schema
 * summary (mcp-server spec §3, pillar: boundary).
 *
 * Exactly one of `path` (CSV file) or `connection_id` (saved warehouse
 * connection) must be given. The response never carries credentials, raw
 * rows, or filesystem contents — only the id, the label, and the same
 * schema summary get_schema returns.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpDeps } from "../deps";
import { registerSource, type McpSource } from "../sources";
import { summarizeSource } from "./get-schema";

export const connectSourceInput = {
  path: z
    .string()
    .optional()
    .describe(
      "Absolute or relative path to a local CSV file. Mutually exclusive with connection_id."
    ),
  connection_id: z
    .string()
    .optional()
    .describe(
      "Id of a saved warehouse connection (created in the hermetic app). Mutually exclusive with path."
    ),
  label: z.string().optional().describe("Optional display label for the source."),
};

/** Refuse to slurp arbitrarily large files into memory. */
const MAX_CSV_BYTES = 200 * 1024 * 1024;

export async function connectSource(
  deps: McpDeps,
  args: { path?: string; connection_id?: string; label?: string }
): Promise<Record<string, unknown>> {
  if (!!args.path === !!args.connection_id) {
    throw new Error("Provide exactly one of `path` or `connection_id`.");
  }

  let source: McpSource;
  if (args.path) {
    const abs = resolve(args.path);
    const size = statSync(abs).size;
    if (size > MAX_CSV_BYTES) {
      throw new Error(
        `File is ${Math.round(size / 1e6)}MB — over the ${MAX_CSV_BYTES / 1e6}MB CSV limit. ` +
          "Use a warehouse connection for data this size."
      );
    }
    const text = readFileSync(abs, "utf-8");
    const parsed = deps.parseCSV(text);
    const csvId = randomUUID();
    const schema = deps.extractSchema(parsed, csvId, basename(abs));
    await deps.storeCSV(csvId, text, schema);
    source = registerSource({
      kind: "csv",
      label: args.label ?? basename(abs),
      csvId,
      schema,
    });
  } else {
    const connections = await deps.loadConnections();
    const saved = connections.find((c) => c.id === args.connection_id);
    if (!saved) {
      const known = connections.map((c) => c.id).join(", ") || "(none)";
      throw new Error(`No saved connection '${args.connection_id}'. Known ids: ${known}`);
    }
    const connector = deps.createConnector(saved.config);
    await connector.testConnection();
    const tables = await connector.introspectAllTables();
    source = registerSource({
      kind: "warehouse",
      label: args.label ?? saved.name ?? saved.label,
      connectionId: saved.id,
      warehouseType: saved.config.type,
      connector,
      tables,
    });
  }

  return { source_id: source.id, ...summarizeSource(source) };
}

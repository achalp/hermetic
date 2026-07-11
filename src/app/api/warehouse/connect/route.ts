import { randomUUID } from "crypto";
import { apiError } from "@/lib/api-error";
import { createConnector } from "@/lib/warehouse/connector";
import { storeWarehouse } from "@/lib/warehouse/storage";
import { saveConnection } from "@/lib/warehouse/persist-env";
import { inferRelationships } from "@/lib/warehouse/infer-relationships";
import { warehouseSourceKey, warehouseTablesFingerprint } from "@/lib/warehouse/schema-fingerprint";
import { resolveWithCache } from "@/lib/schema-cache";
import type { WarehouseConnectionConfig, WarehouseTableSchema } from "@/lib/types";
import { parseBody, WarehouseConnectionConfigSchema } from "@/lib/api-schemas";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    // Full shape validation (zod discriminated union) — previously the body
    // was cast to WarehouseConnectionConfig with only `type` checked, so a
    // config with e.g. a numeric host or missing credentials flowed into the
    // connector and failed opaquely.
    // Read the raw body once: the config schema (a discriminated union) strips
    // unknown keys, so pull the "ignore cache / re-read" flag out first.
    const rawBody = await request.json();
    const force = (rawBody as { force?: unknown })?.force === true;
    const parsed = parseBody(WarehouseConnectionConfigSchema, rawBody);
    if (!parsed.ok) return parsed.response;
    const config: WarehouseConnectionConfig = parsed.data;

    const connector = createConnector(config);

    try {
      await connector.testConnection();
    } catch (err) {
      await connector.close();
      const msg = err instanceof Error ? err.message : "Connection failed";
      return Response.json({ error: `Connection failed: ${msg}` }, { status: 400 });
    }

    let tables;
    try {
      tables = await connector.listTables();
    } catch (err) {
      await connector.close();
      const msg = err instanceof Error ? err.message : "Failed to list tables";
      return Response.json({ error: `Failed to list tables: ${msg}` }, { status: 500 });
    }

    // Introspect all table schemas (columns, PKs, FKs) — the expensive step.
    // Cached by source identity, gated on a cheap fingerprint over the table
    // listing we just fetched (structural: table set + column counts). `force`
    // is the "ignore cache / re-read" control. inferRelationships runs inside
    // the extract so the cached artifact is the finished, relationship-enriched
    // schema.
    let tableSchemas: WarehouseTableSchema[];
    try {
      const resolved = await resolveWithCache<WarehouseTableSchema[]>({
        sourceKey: warehouseSourceKey(config),
        force,
        fingerprint: async () => warehouseTablesFingerprint(tables),
        extract: async () => inferRelationships(await connector.introspectAllTables()),
      });
      tableSchemas = resolved.artifact;
    } catch (err) {
      await connector.close();
      const msg = err instanceof Error ? err.message : "Failed to introspect tables";
      return Response.json({ error: `Failed to introspect tables: ${msg}` }, { status: 500 });
    }

    const warehouseId = randomUUID();
    storeWarehouse(
      {
        warehouseId,
        config,
        tables,
        tableSchemas,
        createdAt: Date.now(),
      },
      connector
    );

    // Persist to .warehouse-connections.json so user doesn't re-enter on next run
    saveConnection(config).catch(() => {
      // Non-fatal — connection still works, just won't persist
    });

    return Response.json({
      warehouse_id: warehouseId,
      warehouse_type: config.type,
      tables,
      table_schemas: tableSchemas,
      table_count: tables.length,
      total_columns: tableSchemas.reduce((sum, t) => sum + t.columns.length, 0),
    });
  } catch (err) {
    return apiError("/api/warehouse/connect", err, "Unknown error");
  }
}

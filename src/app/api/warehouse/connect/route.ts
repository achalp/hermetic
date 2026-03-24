import { randomUUID } from "crypto";
import { createConnector } from "@/lib/warehouse/connector";
import { storeWarehouse } from "@/lib/warehouse/storage";
import { saveConnection } from "@/lib/warehouse/persist-env";
import { inferRelationships } from "@/lib/warehouse/infer-relationships";
import type { WarehouseConnectionConfig } from "@/lib/types";

export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const config: WarehouseConnectionConfig = await request.json();

    if (
      !config?.type ||
      !["postgresql", "bigquery", "clickhouse", "trino", "hive"].includes(config.type)
    ) {
      return Response.json({ error: "Invalid warehouse type" }, { status: 400 });
    }

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

    // Introspect all table schemas (columns, PKs, FKs)
    let tableSchemas;
    try {
      tableSchemas = await connector.introspectAllTables();
    } catch (err) {
      await connector.close();
      const msg = err instanceof Error ? err.message : "Failed to introspect tables";
      return Response.json({ error: `Failed to introspect tables: ${msg}` }, { status: 500 });
    }

    // Infer FK relationships from column naming conventions
    // (supplements native FKs from PostgreSQL; primary source for ClickHouse/BigQuery)
    tableSchemas = inferRelationships(tableSchemas);

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
    const msg = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: msg }, { status: 500 });
  }
}

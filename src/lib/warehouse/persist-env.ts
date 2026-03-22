import { readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import type { WarehouseConnectionConfig } from "@/lib/types";

const CONNECTIONS_PATH = join(process.cwd(), ".warehouse-connections.json");

export interface SavedConnection {
  id: string;
  label: string;
  config: WarehouseConnectionConfig;
  createdAt: string;
}

/** Read all saved connections */
export async function loadConnections(): Promise<SavedConnection[]> {
  try {
    const raw = await readFile(CONNECTIONS_PATH, "utf-8");
    return JSON.parse(raw) as SavedConnection[];
  } catch {
    // Also migrate from legacy .env.local WAREHOUSE_* vars if present
    const legacy = loadLegacyFromEnv();
    if (legacy) {
      const migrated: SavedConnection[] = [
        {
          id: randomUUID(),
          label: buildLabel(legacy),
          config: legacy,
          createdAt: new Date().toISOString(),
        },
      ];
      await writeFile(CONNECTIONS_PATH, JSON.stringify(migrated, null, 2), "utf-8");
      return migrated;
    }
    return [];
  }
}

/** Save a new connection (deduplicates by host+db or project+dataset) */
export async function saveConnection(config: WarehouseConnectionConfig): Promise<SavedConnection> {
  const connections = await loadConnections();
  const label = buildLabel(config);

  // Check for duplicate — same type + same target
  const existingIdx = connections.findIndex((c) => buildLabel(c.config) === label);
  if (existingIdx >= 0) {
    // Update existing
    connections[existingIdx].config = config;
    connections[existingIdx].createdAt = new Date().toISOString();
    await writeFile(CONNECTIONS_PATH, JSON.stringify(connections, null, 2), "utf-8");
    return connections[existingIdx];
  }

  const saved: SavedConnection = {
    id: randomUUID(),
    label,
    config,
    createdAt: new Date().toISOString(),
  };
  connections.push(saved);
  await writeFile(CONNECTIONS_PATH, JSON.stringify(connections, null, 2), "utf-8");
  return saved;
}

/** Remove a saved connection by id */
export async function removeConnection(id: string): Promise<void> {
  const connections = await loadConnections();
  const filtered = connections.filter((c) => c.id !== id);
  if (filtered.length === 0) {
    await unlink(CONNECTIONS_PATH).catch(() => {});
  } else {
    await writeFile(CONNECTIONS_PATH, JSON.stringify(filtered, null, 2), "utf-8");
  }
}

function buildLabel(config: WarehouseConnectionConfig): string {
  switch (config.type) {
    case "postgresql":
      return `PostgreSQL: ${config.host}/${config.database}`;
    case "bigquery":
      return `BigQuery: ${config.projectId}.${config.dataset}`;
    case "clickhouse":
      return `ClickHouse: ${config.host}/${config.database}`;
  }
}

/** Legacy: read single connection from WAREHOUSE_* env vars */
function loadLegacyFromEnv(): WarehouseConnectionConfig | null {
  const type = process.env.WAREHOUSE_TYPE;
  if (!type) return null;

  switch (type) {
    case "postgresql":
      return {
        type: "postgresql",
        host: process.env.WAREHOUSE_PG_HOST ?? "localhost",
        port: Number(process.env.WAREHOUSE_PG_PORT) || 5432,
        database: process.env.WAREHOUSE_PG_DATABASE ?? "",
        user: process.env.WAREHOUSE_PG_USER ?? "",
        password: process.env.WAREHOUSE_PG_PASSWORD ?? "",
        ssl: process.env.WAREHOUSE_PG_SSL === "true",
        schema: process.env.WAREHOUSE_PG_SCHEMA ?? "public",
      };
    case "clickhouse":
      return {
        type: "clickhouse",
        host: process.env.WAREHOUSE_CH_HOST ?? "localhost",
        port: Number(process.env.WAREHOUSE_CH_PORT) || 8123,
        database: process.env.WAREHOUSE_CH_DATABASE ?? "default",
        user: process.env.WAREHOUSE_CH_USER ?? "default",
        password: process.env.WAREHOUSE_CH_PASSWORD ?? "",
        ssl: process.env.WAREHOUSE_CH_SSL === "true",
      };
    default:
      return null;
  }
}

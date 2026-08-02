import { readFile, writeFile, unlink } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
// Per-engine label lives in the engine descriptor (ARCH-12).
import { connectionLabel } from "@/lib/warehouse/engine-descriptor";

const CONNECTIONS_PATH = join(process.cwd(), ".warehouse-connections.json");

export interface SavedConnection {
  id: string;
  /** Auto-generated label from config fields (e.g. "BigQuery: proj.dataset"). */
  label: string;
  /** Optional user-entered friendly name; falls back to `label` for display. */
  name?: string;
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
          label: connectionLabel(legacy),
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
export async function saveConnection(
  config: WarehouseConnectionConfig,
  name?: string
): Promise<SavedConnection> {
  const connections = await loadConnections();
  const label = connectionLabel(config);

  // Check for duplicate — same type + same target
  const existingIdx = connections.findIndex((c) => connectionLabel(c.config) === label);
  if (existingIdx >= 0) {
    // Update existing config; preserve the user's friendly name unless a new
    // one was explicitly supplied (so reconnecting never wipes a rename).
    connections[existingIdx].config = config;
    connections[existingIdx].label = label;
    if (name !== undefined) connections[existingIdx].name = name.trim() || undefined;
    connections[existingIdx].createdAt = new Date().toISOString();
    await writeFile(CONNECTIONS_PATH, JSON.stringify(connections, null, 2), "utf-8");
    return connections[existingIdx];
  }

  const saved: SavedConnection = {
    id: randomUUID(),
    label,
    name: name?.trim() || undefined,
    config,
    createdAt: new Date().toISOString(),
  };
  connections.push(saved);
  await writeFile(CONNECTIONS_PATH, JSON.stringify(connections, null, 2), "utf-8");
  return saved;
}

/** Rename a saved connection (empty string clears back to the auto label). */
export async function renameConnection(id: string, name: string): Promise<void> {
  const connections = await loadConnections();
  const conn = connections.find((c) => c.id === id);
  if (!conn) return;
  conn.name = name.trim() || undefined;
  await writeFile(CONNECTIONS_PATH, JSON.stringify(connections, null, 2), "utf-8");
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
    case "bigquery":
      // .env.example documented these vars for years while this switch
      // silently ignored them — a user following the example set four vars
      // that did nothing and concluded the feature was broken.
      return {
        type: "bigquery",
        projectId: process.env.WAREHOUSE_BQ_PROJECT ?? "",
        dataset: process.env.WAREHOUSE_BQ_DATASET ?? "",
        credentialsJson: process.env.WAREHOUSE_BQ_CREDENTIALS_JSON ?? "",
      };
    default:
      return null;
  }
}

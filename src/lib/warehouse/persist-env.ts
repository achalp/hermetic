import { readFile, writeFile, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
// Per-engine label lives in the engine descriptor (ARCH-12).
import { connectionLabel } from "@/lib/warehouse/engine-descriptor";
import { envConfig } from "@/lib/harness-slot";
import { hermeticPaths } from "@/lib/paths";
import { logger } from "@/lib/logger";
import {
  keychainAvailable,
  getWarehouseSecrets,
  setWarehouseSecrets,
  deleteWarehouseSecrets,
} from "@/lib/secrets";

// Credentials live INSIDE the data dir (M2-C1) — previously a hidden file at
// the repo root, invisible to backups/gitignore reasoning and unmovable.
// Resolved per call, not at import — a module-level const froze the pre-boot
// default before the harness could call setPathRoots (the seam in lib/paths.ts).
const connectionsPath = () => hermeticPaths.warehouseConnectionsFile();
const legacyConnectionsPath = () => hermeticPaths.legacyWarehouseConnectionsFile();

export interface SavedConnection {
  id: string;
  /** Auto-generated label from config fields (e.g. "BigQuery: proj.dataset"). */
  label: string;
  /** Optional user-entered friendly name; falls back to `label` for display. */
  name?: string;
  config: WarehouseConnectionConfig;
  createdAt: string;
}

// ── Credential separation (secrets-and-settings spec, 2026-08-06) ────
// The connections FILE persists non-secret metadata only; credential fields
// live in the OS keychain, one JSON blob per connection id. Every write goes
// through persistConnections (scrub → keychain → file); every read merges
// the keychain blob back. On systems with no credential service the legacy
// plaintext behavior is kept — losing headless deployments would be worse —
// with a one-time warning.

const SECRET_CONFIG_FIELDS = ["password", "credentialsJson", "token", "privateKey"] as const;

function splitSecrets(config: WarehouseConnectionConfig): {
  publicConfig: WarehouseConnectionConfig;
  secrets: Record<string, string>;
} {
  const pub = { ...(config as unknown as Record<string, unknown>) };
  const secrets: Record<string, string> = {};
  for (const field of SECRET_CONFIG_FIELDS) {
    const v = pub[field];
    if (typeof v === "string" && v !== "") {
      secrets[field] = v;
      delete pub[field];
    }
  }
  return { publicConfig: pub as unknown as WarehouseConnectionConfig, secrets };
}

function hasEmbeddedSecrets(conn: SavedConnection): boolean {
  const cfg = conn.config as unknown as Record<string, unknown>;
  return SECRET_CONFIG_FIELDS.some((f) => typeof cfg[f] === "string" && cfg[f] !== "");
}

/** Keychain blob merged over the on-file config (no-op for legacy files). */
function withSecrets(conn: SavedConnection): SavedConnection {
  const secrets = getWarehouseSecrets(conn.id);
  if (!secrets) return conn;
  return {
    ...conn,
    config: {
      ...(conn.config as unknown as Record<string, unknown>),
      ...secrets,
    } as unknown as WarehouseConnectionConfig,
  };
}

let warnedLegacyPlaintext = false;

/** THE single write path: scrub credentials to the keychain, then file. */
async function persistConnections(connections: SavedConnection[]): Promise<void> {
  let toDisk = connections;
  if (keychainAvailable()) {
    toDisk = connections.map((conn) => {
      const { publicConfig, secrets } = splitSecrets(conn.config);
      if (Object.keys(secrets).length === 0) return { ...conn, config: publicConfig };
      try {
        setWarehouseSecrets(conn.id, secrets);
        return { ...conn, config: publicConfig };
      } catch (err) {
        // Losing a credential is worse than persisting it — keep this one
        // in the file and say so.
        logger.warn("warehouse: keychain write failed — credential kept in file", {
          connectionId: conn.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return conn;
      }
    });
  } else if (connections.some(hasEmbeddedSecrets) && !warnedLegacyPlaintext) {
    warnedLegacyPlaintext = true;
    logger.warn(
      "warehouse: no OS credential service — connection credentials remain in " +
        "data/warehouse-connections (legacy plaintext mode)"
    );
  }
  await writeFile(connectionsPath(), JSON.stringify(toDisk, null, 2), "utf-8");
}

/** Read all saved connections */
export async function loadConnections(): Promise<SavedConnection[]> {
  try {
    const raw = await readFile(connectionsPath(), "utf-8");
    const parsed = JSON.parse(raw) as SavedConnection[];
    // One-time migration: a pre-keychain file carries embedded credentials —
    // move them out (persistConnections scrubs) as soon as a keychain exists.
    if (keychainAvailable() && parsed.some(hasEmbeddedSecrets)) {
      await persistConnections(parsed);
      logger.info("warehouse: migrated connection credentials into the OS keychain", {
        connections: parsed.length,
      });
    }
    return parsed.map(withSecrets);
  } catch {
    // One-time migration from the pre-C1 repo-root location.
    try {
      const legacyRaw = await readFile(legacyConnectionsPath(), "utf-8");
      const parsed = JSON.parse(legacyRaw) as SavedConnection[];
      await persistConnections(parsed);
      await unlink(legacyConnectionsPath()).catch(() => {});
      return parsed.map(withSecrets);
    } catch {
      // fall through to env-var migration
    }
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
      await persistConnections(migrated);
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
    await persistConnections(connections);
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
  await persistConnections(connections);
  return saved;
}

/** Rename a saved connection (empty string clears back to the auto label). */
export async function renameConnection(id: string, name: string): Promise<void> {
  const connections = await loadConnections();
  const conn = connections.find((c) => c.id === id);
  if (!conn) return;
  conn.name = name.trim() || undefined;
  await persistConnections(connections);
}

/** Remove a saved connection by id */
export async function removeConnection(id: string): Promise<void> {
  const connections = await loadConnections();
  const filtered = connections.filter((c) => c.id !== id);
  deleteWarehouseSecrets(id);
  if (filtered.length === 0) {
    await unlink(connectionsPath()).catch(() => {});
  } else {
    await persistConnections(filtered);
  }
}

/** Legacy: read single connection from WAREHOUSE_* env vars */
function loadLegacyFromEnv(): WarehouseConnectionConfig | null {
  const type = envConfig().WAREHOUSE_TYPE;
  if (!type) return null;

  switch (type) {
    case "postgresql":
      return {
        type: "postgresql",
        host: envConfig().WAREHOUSE_PG_HOST ?? "localhost",
        port: Number(envConfig().WAREHOUSE_PG_PORT) || 5432,
        database: envConfig().WAREHOUSE_PG_DATABASE ?? "",
        user: envConfig().WAREHOUSE_PG_USER ?? "",
        password: envConfig().WAREHOUSE_PG_PASSWORD ?? "",
        ssl: envConfig().WAREHOUSE_PG_SSL === "true",
        schema: envConfig().WAREHOUSE_PG_SCHEMA ?? "public",
      };
    case "clickhouse":
      return {
        type: "clickhouse",
        host: envConfig().WAREHOUSE_CH_HOST ?? "localhost",
        port: Number(envConfig().WAREHOUSE_CH_PORT) || 8123,
        database: envConfig().WAREHOUSE_CH_DATABASE ?? "default",
        user: envConfig().WAREHOUSE_CH_USER ?? "default",
        password: envConfig().WAREHOUSE_CH_PASSWORD ?? "",
        ssl: envConfig().WAREHOUSE_CH_SSL === "true",
      };
    case "bigquery":
      // .env.example documented these vars for years while this switch
      // silently ignored them — a user following the example set four vars
      // that did nothing and concluded the feature was broken.
      return {
        type: "bigquery",
        projectId: envConfig().WAREHOUSE_BQ_PROJECT ?? "",
        dataset: envConfig().WAREHOUSE_BQ_DATASET ?? "",
        credentialsJson: envConfig().WAREHOUSE_BQ_CREDENTIALS_JSON ?? "",
      };
    default:
      return null;
  }
}

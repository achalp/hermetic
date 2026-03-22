import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import type { WarehouseConnectionConfig } from "@/lib/types";

const ENV_LOCAL_PATH = join(process.cwd(), ".env.local");

/** All WAREHOUSE_* keys we manage */
const WAREHOUSE_KEYS = [
  "WAREHOUSE_TYPE",
  "WAREHOUSE_PG_HOST",
  "WAREHOUSE_PG_PORT",
  "WAREHOUSE_PG_DATABASE",
  "WAREHOUSE_PG_USER",
  "WAREHOUSE_PG_PASSWORD",
  "WAREHOUSE_PG_SCHEMA",
  "WAREHOUSE_PG_SSL",
  "WAREHOUSE_BQ_PROJECT",
  "WAREHOUSE_BQ_DATASET",
  "WAREHOUSE_BQ_CREDENTIALS_JSON",
  "WAREHOUSE_CH_HOST",
  "WAREHOUSE_CH_PORT",
  "WAREHOUSE_CH_DATABASE",
  "WAREHOUSE_CH_USER",
  "WAREHOUSE_CH_PASSWORD",
  "WAREHOUSE_CH_SSL",
];

/**
 * Save warehouse connection config to .env.local so it persists across restarts.
 * Replaces any existing WAREHOUSE_* lines.
 */
export async function saveWarehouseToEnv(config: WarehouseConnectionConfig): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(ENV_LOCAL_PATH, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  // Remove all existing WAREHOUSE_* lines
  const lines = existing.split("\n").filter((line) => {
    const key = line.split("=")[0]?.trim();
    return !WAREHOUSE_KEYS.includes(key);
  });

  // Remove trailing blank lines, then add one
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  lines.push("");

  // Add new warehouse config
  const newLines = await configToEnvLines(config);
  lines.push(...newLines, "");

  await writeFile(ENV_LOCAL_PATH, lines.join("\n"), "utf-8");
}

async function configToEnvLines(config: WarehouseConnectionConfig): Promise<string[]> {
  switch (config.type) {
    case "postgresql":
      return [
        `WAREHOUSE_TYPE=postgresql`,
        `WAREHOUSE_PG_HOST=${config.host}`,
        `WAREHOUSE_PG_PORT=${config.port}`,
        `WAREHOUSE_PG_DATABASE=${config.database}`,
        `WAREHOUSE_PG_USER=${config.user}`,
        `WAREHOUSE_PG_PASSWORD=${config.password}`,
        `WAREHOUSE_PG_SCHEMA=${config.schema ?? "public"}`,
        `WAREHOUSE_PG_SSL=${config.ssl ? "true" : "false"}`,
      ];
    case "bigquery": {
      // Save credentials JSON to a separate file (too large/complex for env var)
      const credsPath = join(process.cwd(), ".bigquery-credentials.json");
      await writeFile(credsPath, config.credentialsJson, "utf-8");
      return [
        `WAREHOUSE_TYPE=bigquery`,
        `WAREHOUSE_BQ_PROJECT=${config.projectId}`,
        `WAREHOUSE_BQ_DATASET=${config.dataset}`,
        `WAREHOUSE_BQ_CREDENTIALS_JSON=${credsPath}`,
      ];
    }
    case "clickhouse":
      return [
        `WAREHOUSE_TYPE=clickhouse`,
        `WAREHOUSE_CH_HOST=${config.host}`,
        `WAREHOUSE_CH_PORT=${config.port}`,
        `WAREHOUSE_CH_DATABASE=${config.database}`,
        `WAREHOUSE_CH_USER=${config.user}`,
        `WAREHOUSE_CH_PASSWORD=${config.password}`,
        `WAREHOUSE_CH_SSL=${config.ssl ? "true" : "false"}`,
      ];
  }
}

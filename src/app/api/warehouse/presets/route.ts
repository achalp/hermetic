import type { WarehouseConnectionConfig } from "@/lib/types";
import { readFile } from "fs/promises";

/**
 * Returns pre-configured warehouse connection from environment variables.
 * Credentials are never sent to the LLM or sandbox — only used server-side.
 */
export async function GET() {
  const preset = await buildPresetFromEnv();

  if (!preset) {
    return Response.json({ preset: null });
  }

  return Response.json({ preset });
}

async function buildPresetFromEnv(): Promise<WarehouseConnectionConfig | null> {
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

    case "bigquery": {
      let credentialsJson = process.env.WAREHOUSE_BQ_CREDENTIALS_JSON ?? "";
      // If it looks like a file path (not JSON), read the file
      if (credentialsJson && !credentialsJson.trimStart().startsWith("{")) {
        try {
          credentialsJson = await readFile(credentialsJson, "utf-8");
        } catch {
          // leave as-is if file can't be read
        }
      }
      return {
        type: "bigquery",
        projectId: process.env.WAREHOUSE_BQ_PROJECT ?? "",
        dataset: process.env.WAREHOUSE_BQ_DATASET ?? "",
        credentialsJson,
      };
    }

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

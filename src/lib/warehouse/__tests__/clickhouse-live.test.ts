/**
 * Live integration test against the PUBLIC ClickHouse Playground
 * (sql-clickhouse.clickhouse.com, user `demo`, read-only, no password).
 *
 * Opt-in — it reaches the public internet, so it is skipped unless
 * HERMETIC_LIVE_WAREHOUSE=1 is set, and skipped again if the endpoint is
 * unreachable. It exercises the REAL @clickhouse/client path (not a driver
 * mock): connect, list, introspect real column types, run a SELECT, and prove
 * the read-only gate rejects writes on a live connection.
 *
 *   HERMETIC_LIVE_WAREHOUSE=1 pnpm test src/lib/warehouse/__tests__/clickhouse-live.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createConnector } from "../connector";
import type { ClickHouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type { WarehouseConnector } from "../connector";

const CONFIG: ClickHouseConnectionConfig = {
  type: "clickhouse",
  host: "sql-clickhouse.clickhouse.com",
  port: 443,
  database: "ontime", // a single-table public dataset — fast to introspect
  user: "demo",
  password: "",
  ssl: true,
};

const OPTED_IN = process.env.HERMETIC_LIVE_WAREHOUSE === "1";

async function reachable(): Promise<boolean> {
  try {
    const c = createConnector(CONFIG);
    await c.testConnection();
    await c.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!OPTED_IN)("ClickHouse connector — live public Playground integration", () => {
  let run = false;
  let connector: WarehouseConnector;

  beforeAll(async () => {
    if (!OPTED_IN) return;
    run = await reachable();
    if (run) connector = createConnector(CONFIG);
  }, 30_000);

  afterAll(async () => {
    if (connector) await connector.close();
  });

  const live = (name: string, fn: () => Promise<void>, timeout = 30_000) =>
    it(
      name,
      async (ctx) => {
        if (!run) ctx.skip(); // opted in but endpoint down: skip, don't fail on network
        await fn();
      },
      timeout
    );

  live("connects to the live endpoint", async () => {
    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  live("lists tables including the ontime table", async () => {
    const tables = await connector.listTables();
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((t) => t.name)).toContain("ontime");
  });

  live(
    "introspects real column names and types",
    async () => {
      const schemas = await connector.introspectAllTables();
      const ontime = schemas.find((s) => s.name === "ontime");
      expect(ontime).toBeDefined();
      expect(ontime!.columns.length).toBeGreaterThan(10);
      const year = ontime!.columns.find((c) => c.name === "Year");
      expect(year?.type).toMatch(/int/i); // UInt16 in the live schema
    },
    60_000
  );

  live("runs a real SELECT and returns CSV rows", async () => {
    const csv = await connector.executeSQL("SELECT 1 AS ok, 'hi' AS label");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("ok"); // header
    expect(lines.length).toBeGreaterThanOrEqual(2); // header + >=1 row
  });

  live("the read-only gate rejects writes on the live connection", async () => {
    // the guard throws synchronously before the query is sent; the async thunk
    // normalizes a sync throw and a rejected promise alike.
    await expect(async () => connector.executeSQL("DROP TABLE ontime.ontime")).rejects.toThrow(
      /read-only/i
    );
    await expect(async () =>
      connector.executeSQL("INSERT INTO ontime.ontime (Year) VALUES (2000)")
    ).rejects.toThrow(/read-only/i);
  });
});

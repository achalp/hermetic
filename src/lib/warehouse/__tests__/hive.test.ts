/** Hive connector: session→operation getSchema/fetchChunk→CSV, and the
 *  read-only gate — previously untested. hive-driver (thrift) is mocked. */
import { describe, it, expect, vi } from "vitest";

/** Every statement the (mock) server received — the P15 test counts round-trips. */
const executedSql: string[] = [];

/** SQL-aware operation: SHOW TABLES / DESCRIBE / data queries each yield the
 *  right row shape, one chunk then exhausted. */
function opFor(sql: string) {
  let served = false;
  const rowsFor = (): unknown[][] => {
    if (/^SHOW TABLES/i.test(sql)) return [["orders"], ["users"]];
    if (/^DESCRIBE/i.test(sql)) {
      return [
        ["a", "int"],
        ["b", "string"],
      ];
    }
    return [
      [1, 2],
      [3, 4],
    ];
  };
  return {
    getSchema: async () => ({ columns: [{ columnName: "a" }, { columnName: "b" }] }),
    fetchChunk: async () => (served ? [] : ((served = true), rowsFor())),
    hasMoreRows: async () => false,
    close: async () => {},
  };
}

vi.mock("hive-driver", () => ({
  thrift: { TCLIService_types: { TProtocolVersion: { HIVE_CLI_SERVICE_PROTOCOL_V10: 10 } } },
  auth: { PlainTcpAuthentication: class {}, NoSaslAuthentication: class {} },
  connections: { TcpConnection: class {} },
  HiveClient: class {
    connect = async () => {};
    openSession = async () => ({
      executeStatement: async (sql: string) => {
        executedSql.push(sql);
        return opFor(sql);
      },
      close: async () => {},
    });
  },
}));

import { createConnector } from "../connector";
import type { HiveConnectionConfig } from "@/lib/contracts/connection-configs";

const CONFIG: HiveConnectionConfig = {
  type: "hive",
  host: "h",
  port: 10000,
  database: "default",
  user: "u",
  password: "",
  auth: "NONE",
};

describe("hive connector", () => {
  it("executeSQL joins the schema columns with fetched array rows into CSV", async () => {
    const conn = createConnector(CONFIG);
    expect(await conn.executeSQL("SELECT a, b FROM t")).toBe("a,b\n1,2\n3,4\n");
  });
  it("rejects a write at the read-only gate", async () => {
    const conn = createConnector(CONFIG);
    await expect(async () => conn.executeSQL("INSERT INTO t VALUES (1)")).rejects.toThrow();
  });

  it("cold connect: introspectAllTables reuses the listTables probe — no duplicate SHOW/DESCRIBE (perf P15)", async () => {
    executedSql.length = 0;
    const conn = createConnector(CONFIG);
    await conn.listTables();
    const describesAfterList = executedSql.filter((s) => /^DESCRIBE/i.test(s)).length;
    expect(describesAfterList).toBe(2); // one per table

    const schemas = await conn.introspectAllTables();
    // Introspection is CORRECT (assembled from the probe's DESCRIBE rows)…
    expect(schemas.map((s) => s.name)).toEqual(["orders", "users"]);
    expect(schemas[0].columns.map((c) => c.name)).toEqual(["a", "b"]);
    // …and issued NO new SHOW TABLES / DESCRIBE round-trips.
    expect(executedSql.filter((s) => /^DESCRIBE/i.test(s)).length).toBe(describesAfterList);
    expect(executedSql.filter((s) => /^SHOW TABLES/i.test(s)).length).toBe(1);

    // Consume-once: a SECOND, standalone introspect queries FRESH (the probe
    // must never serve stale results).
    await conn.introspectAllTables();
    expect(executedSql.filter((s) => /^SHOW TABLES/i.test(s)).length).toBe(2);
    expect(executedSql.filter((s) => /^DESCRIBE/i.test(s)).length).toBe(describesAfterList + 2);
  });
});

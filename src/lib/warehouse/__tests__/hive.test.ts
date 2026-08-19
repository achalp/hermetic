/** Hive connector: session→operation getSchema/fetchChunk→CSV, and the
 *  read-only gate — previously untested. hive-driver (thrift) is mocked. */
import { describe, it, expect, vi } from "vitest";

const operation = {
  getSchema: async () => ({ columns: [{ columnName: "a" }, { columnName: "b" }] }),
  fetchChunk: async () => [
    [1, 2],
    [3, 4],
  ],
  hasMoreRows: async () => false,
  close: async () => {},
};

vi.mock("hive-driver", () => ({
  thrift: { TCLIService_types: { TProtocolVersion: { HIVE_CLI_SERVICE_PROTOCOL_V10: 10 } } },
  auth: { PlainTcpAuthentication: class {}, NoSaslAuthentication: class {} },
  connections: { TcpConnection: class {} },
  HiveClient: class {
    connect = async () => {};
    openSession = async () => ({
      executeStatement: async () => operation,
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
});

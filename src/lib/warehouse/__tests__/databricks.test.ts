/** Databricks connector: connect→session→statement, object-rows→CSV, and the
 *  read-only gate — previously untested. @databricks/sql is mocked. */
import { describe, it, expect, vi } from "vitest";

vi.mock("@databricks/sql", () => ({
  DBSQLClient: class {
    connect = async () => {};
    openSession = async () => ({
      executeStatement: async () => {
        // executeSQL streams via fetchChunk/hasMoreRows; introspection uses
        // fetchAll. One chunk, then no more rows.
        let served = false;
        return {
          fetchAll: async () => [
            { a: 1, b: 2 },
            { a: 3, b: 4 },
          ],
          fetchChunk: async () =>
            served
              ? []
              : ((served = true),
                [
                  { a: 1, b: 2 },
                  { a: 3, b: 4 },
                ]),
          hasMoreRows: async () => false,
          close: async () => {},
        };
      },
      close: async () => {},
    });
    close = async () => {};
  },
}));

import { createConnector } from "../connector";
import type { DatabricksConnectionConfig } from "@/lib/contracts/connection-configs";

const CONFIG: DatabricksConnectionConfig = {
  type: "databricks",
  serverHostname: "h.databricks.com",
  httpPath: "/sql/1.0/warehouses/x",
  token: "t",
  catalog: "main",
  schema: "default",
};

describe("databricks connector", () => {
  it("executeSQL serializes fetched rows to CSV", async () => {
    const conn = createConnector(CONFIG);
    expect(await conn.executeSQL("SELECT a, b FROM t")).toBe("a,b\n1,2\n3,4\n");
  });
  it("rejects a write at the read-only gate", async () => {
    const conn = createConnector(CONFIG);
    await expect(async () => conn.executeSQL("DROP TABLE t")).rejects.toThrow();
  });
});

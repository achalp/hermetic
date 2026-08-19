/** Trino connector: config→client, streamed rows→CSV, and the read-only gate
 *  (via createConnector) — previously untested. Driver is mocked; no live Trino. */
import { describe, it, expect, vi } from "vitest";

vi.mock("trino-client", () => ({
  Trino: {
    create: vi.fn(() => ({
      query: vi.fn(async () => {
        let i = 0;
        return {
          next: async () =>
            i++ === 0
              ? {
                  done: false,
                  value: {
                    columns: [{ name: "a" }, { name: "b" }],
                    data: [
                      [1, 2],
                      [3, 4],
                    ],
                  },
                }
              : { done: true, value: undefined },
        };
      }),
    })),
  },
  BasicAuth: class {},
}));

import { createConnector } from "../connector";
import type { TrinoConnectionConfig } from "@/lib/contracts/connection-configs";

const CONFIG: TrinoConnectionConfig = {
  type: "trino",
  host: "h",
  port: 8080,
  user: "u",
  catalog: "c",
  schema: "s",
  password: "",
  ssl: false,
};

describe("trino connector", () => {
  it("executeSQL streams the driver's rows into CSV (columns + data)", async () => {
    const conn = createConnector(CONFIG);
    expect(await conn.executeSQL("SELECT a, b FROM t")).toBe("a,b\n1,2\n3,4\n");
  });
  it("rejects a write at the read-only gate", async () => {
    const conn = createConnector(CONFIG);
    await expect(async () => conn.executeSQL("DELETE FROM t")).rejects.toThrow();
  });
});

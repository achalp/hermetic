/** Snowflake connector: config→connection, object-rows→CSV (rowsToCsv), and
 *  the read-only gate — previously untested. snowflake-sdk is mocked. */
import { describe, it, expect, vi } from "vitest";

vi.mock("snowflake-sdk", () => ({
  default: {
    configure: vi.fn(),
    createConnection: vi.fn(() => ({
      connect: (cb: (e?: unknown) => void) => cb(),
      execute: ({ complete }: { complete: (e: unknown, s: unknown, rows: unknown[]) => void }) => {
        complete(null, null, [
          { A: 1, B: 2 },
          { A: 3, B: 4 },
        ]);
        return { cancel: (c: () => void) => c() };
      },
      destroy: (cb: () => void) => cb(),
    })),
  },
}));

import { createConnector } from "../connector";
import type { SnowflakeConnectionConfig } from "@/lib/contracts/connection-configs";

const CONFIG: SnowflakeConnectionConfig = {
  type: "snowflake",
  account: "acct",
  user: "u",
  password: "p",
  database: "db",
  schema: "PUBLIC",
};

describe("snowflake connector", () => {
  it("executeSQL serializes object rows to CSV via the first row's keys", async () => {
    const conn = createConnector(CONFIG);
    expect(await conn.executeSQL("SELECT a, b FROM t")).toBe("A,B\n1,2\n3,4\n");
  });
  it("rejects a write at the read-only gate", async () => {
    const conn = createConnector(CONFIG);
    await expect(async () => conn.executeSQL("UPDATE t SET a=1")).rejects.toThrow();
  });

  it("disables snowflake-sdk file logging (no plaintext ./snowflake.log)", async () => {
    const snowflake = (await import("snowflake-sdk")).default as unknown as {
      configure: ReturnType<typeof vi.fn>;
    };
    snowflake.configure.mockClear();
    createConnector(CONFIG);
    expect(snowflake.configure).toHaveBeenCalledWith({ logLevel: "OFF" });
  });
});

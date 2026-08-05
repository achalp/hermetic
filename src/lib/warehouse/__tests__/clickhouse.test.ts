/**
 * The readonly=2 defense-in-depth vs already-readonly servers (found live
 * against play.clickhouse.com): a user profile at readonly=1 refuses ANY
 * per-request setting change — including tightening `readonly` itself — so
 * the connector must fall back once to a client that doesn't send the
 * setting, and only on that specific refusal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const created: Array<{
  settings: unknown;
  query: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];
let refuseReadonly = false;

vi.mock("@clickhouse/client", () => ({
  createClient: vi.fn((opts: { clickhouse_settings?: unknown }) => {
    const instance = {
      settings: opts.clickhouse_settings,
      query: vi.fn(async () => {
        if (refuseReadonly && opts.clickhouse_settings) {
          const err = new Error("Cannot modify 'readonly' setting in readonly mode. ") as Error & {
            type: string;
          };
          err.type = "READONLY";
          throw err;
        }
        return {
          json: async () => [],
          text: async () => "a,b\n1,2\n",
        };
      }),
      ping: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    created.push(instance);
    return instance;
  }),
}));

import { createClickHouseConnector } from "../clickhouse";
import type { ClickHouseConnectionConfig } from "@/lib/contracts/connection-configs";

const CONFIG: ClickHouseConnectionConfig = {
  type: "clickhouse",
  host: "example.test",
  port: 8443,
  database: "default",
  user: "demo",
  password: "",
  ssl: true,
};

beforeEach(() => {
  created.length = 0;
  refuseReadonly = false;
});

describe("clickhouse connector readonly defense", () => {
  it("sends readonly=2 by default and does not fall back on writable servers", async () => {
    const connector = createClickHouseConnector(CONFIG);
    await connector.executeSQL("SELECT 1");
    expect(created).toHaveLength(1);
    expect(created[0].settings).toEqual({ readonly: "2" });
  });

  it("falls back once, without the setting, when the server is already readonly", async () => {
    refuseReadonly = true;
    const connector = createClickHouseConnector(CONFIG);
    const csv = await connector.executeSQL("SELECT 1");
    expect(csv).toContain("a,b");
    // First client sent the setting and was refused; the fallback client
    // omits it entirely.
    expect(created).toHaveLength(2);
    expect(created[0].settings).toEqual({ readonly: "2" });
    expect(created[1].settings).toBeUndefined();
    expect(created[0].close).toHaveBeenCalled();

    // Subsequent queries stay on the fallback client — no per-call churn.
    await connector.executeSQL("SELECT 2");
    expect(created).toHaveLength(2);
  });

  it("does NOT fall back on unrelated errors", async () => {
    const connector = createClickHouseConnector(CONFIG);
    created[0].query.mockRejectedValueOnce(new Error("Syntax error"));
    await expect(connector.executeSQL("SELEC 1")).rejects.toThrow("Syntax error");
    expect(created).toHaveLength(1);
  });
});

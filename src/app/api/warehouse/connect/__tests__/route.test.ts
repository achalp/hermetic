import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract test for /api/warehouse/connect — focused on the schema-cache
 * `force` plumbing. The config body is a zod discriminated union that STRIPS
 * unknown keys, so `force` must be read from the raw body before parsing; this
 * pins that it reaches the cache resolver and doesn't corrupt config parsing.
 * Connector / storage / cache are mocked so no warehouse or disk is touched.
 */

const connector = {
  testConnection: vi.fn(async () => undefined),
  listTables: vi.fn(async () => [
    { schema: "public", name: "t", column_count: 2, row_count_estimate: 9 },
  ]),
  introspectAllTables: vi.fn(async () => [
    { schema: "public", name: "t", columns: [], row_count_estimate: 9 },
  ]),
  close: vi.fn(async () => undefined),
};
vi.mock("@/lib/warehouse/connector", () => ({ createConnector: () => connector }));
vi.mock("@/lib/warehouse/storage", () => ({ storeWarehouse: vi.fn() }));
vi.mock("@/lib/warehouse/persist-env", () => ({ saveConnection: vi.fn(async () => undefined) }));
vi.mock("@/lib/warehouse/infer-relationships", () => ({
  inferRelationships: (t: unknown) => t,
}));

const resolveWithCache = vi.fn(
  async (opts: {
    extract: () => Promise<unknown>;
    force?: boolean;
    fingerprint: () => Promise<string>;
  }) => {
    await opts.fingerprint(); // exercise the cheap probe
    return { artifact: await opts.extract(), status: opts.force ? "forced" : "miss" };
  }
);
vi.mock("@/lib/schema-cache", () => ({
  resolveWithCache: (opts: unknown) => resolveWithCache(opts as never),
}));

import { POST } from "../route";

const config = {
  type: "postgresql",
  host: "h",
  port: 5432,
  database: "d",
  user: "u",
  password: "p",
  schema: "public",
};

const req = (body: unknown) =>
  new Request("http://localhost/api/warehouse/connect", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/warehouse/connect", () => {
  it("connects, introspects through the cache, and returns the schema (default = use cache)", async () => {
    const res = await POST(req(config));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.warehouse_id).toBeTruthy();
    expect(resolveWithCache).toHaveBeenCalledOnce();
    expect(resolveWithCache.mock.calls[0]![0].force).toBe(false);
    // introspection ran via the cache's extract (a miss).
    expect(connector.introspectAllTables).toHaveBeenCalledOnce();
  });

  it("passes force:true from the body to the cache resolver (union strips the key, config still valid)", async () => {
    const res = await POST(req({ ...config, force: true }));
    expect(res.status).toBe(200); // force didn't break discriminated-union parsing
    expect(resolveWithCache.mock.calls[0]![0].force).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Postgres connector: SSL verification default (finding L3) and the streaming
 * cursor extract path with AbortSignal cancellation (finding 10).
 *
 * We mock `pg` so no database is needed — the fake Pool hands out clients whose
 * `query` dispatches on the SQL text (pg_backend_pid / BEGIN / DECLARE / FETCH /
 * ROLLBACK / pg_cancel_backend), letting us assert the cursor mechanics and the
 * second-connection cancellation without a live server.
 */

interface Executed {
  sql: string;
  params?: unknown[];
}
const executed: Executed[] = [];
let poolConfig: Record<string, unknown> | undefined;
let fetchImpl: () => Promise<{ fields: { name: string }[]; rows: Record<string, unknown>[] }>;

function makeClient() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql: string, params?: unknown[]): Promise<any> {
      executed.push({ sql, params });
      if (/pg_backend_pid/.test(sql)) return { rows: [{ pid: 4242 }], fields: [] };
      if (/^FETCH FORWARD/.test(sql)) return fetchImpl();
      return { rows: [], fields: [] };
    },
    release: vi.fn(),
  };
}

vi.mock("pg", () => {
  class Pool {
    constructor(cfg: Record<string, unknown>) {
      poolConfig = cfg;
    }
    connect() {
      return Promise.resolve(makeClient());
    }
    async end() {}
  }
  return { default: { Pool } };
});

import { createPostgresConnector, resolvePostgresSsl } from "@/lib/warehouse/postgres";
import type { PostgresConnectionConfig } from "@/lib/contracts/connection-configs";

const BASE: PostgresConnectionConfig = {
  type: "postgresql",
  host: "localhost",
  port: 5432,
  database: "db",
  user: "u",
  password: "p",
};

beforeEach(() => {
  executed.length = 0;
  poolConfig = undefined;
  // Default: one page of two rows, then exhausted (len < batch → loop stops).
  let served = false;
  fetchImpl = async () => {
    if (served) return { fields: [{ name: "a" }, { name: "b" }], rows: [] };
    served = true;
    return {
      fields: [{ name: "a" }, { name: "b" }],
      rows: [
        { a: 1, b: "x,y" },
        { a: 2, b: "z" },
      ],
    };
  };
});

describe("resolvePostgresSsl (finding L3 — verify certs by default)", () => {
  it("ssl off → no TLS", () => {
    expect(resolvePostgresSsl({ ssl: false })).toBe(false);
    expect(resolvePostgresSsl({})).toBe(false);
  });

  it("ssl on → VERIFIES the cert by default (MITM protection)", () => {
    expect(resolvePostgresSsl({ ssl: true })).toEqual({ rejectUnauthorized: true });
  });

  it("ssl on + explicit opt-in → trusts a self-signed cert", () => {
    expect(resolvePostgresSsl({ ssl: true, sslRejectUnauthorized: false })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("ssl on + explicit true → verifies (same as default)", () => {
    expect(resolvePostgresSsl({ ssl: true, sslRejectUnauthorized: true })).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("pool is constructed with the resolved (secure) ssl option", () => {
    createPostgresConnector({ ...BASE, ssl: true });
    expect(poolConfig?.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe("postgres executeSQL (finding 10 — streaming cursor)", () => {
  it("streams via a server-side cursor (DECLARE + FETCH), not pool.query buffering", async () => {
    const connector = createPostgresConnector(BASE);
    const csv = await connector.executeSQL("SELECT a, b FROM t");
    // Canonical CSV, comma-bearing value quoted.
    expect(csv).toBe('a,b\n1,"x,y"\n2,z\n');

    const sqls = executed.map((e) => e.sql);
    expect(sqls).toContain("BEGIN");
    expect(sqls.some((s) => /^DECLARE .* CURSOR FOR SELECT a, b FROM t$/.test(s))).toBe(true);
    expect(sqls.some((s) => /^FETCH FORWARD/.test(s))).toBe(true);
    // Cursor is torn down.
    expect(sqls).toContain("ROLLBACK");
  });

  it("strips a trailing semicolon so the SELECT nests inside DECLARE", async () => {
    const connector = createPostgresConnector(BASE);
    await connector.executeSQL("SELECT a, b FROM t;  ");
    const declare = executed.find((e) => /^DECLARE/.test(e.sql))!.sql;
    expect(declare.endsWith("FROM t")).toBe(true);
    expect(declare).not.toContain(";");
  });

  it("no data rows → empty string", async () => {
    fetchImpl = async () => ({ fields: [{ name: "a" }], rows: [] });
    const connector = createPostgresConnector(BASE);
    expect(await connector.executeSQL("SELECT a FROM t WHERE false")).toBe("");
  });

  it("throws AbortError immediately when the signal is already aborted (no connect)", async () => {
    const connector = createPostgresConnector(BASE);
    await expect(connector.executeSQL("SELECT 1", AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(executed).toHaveLength(0);
  });

  it("on mid-flight abort, cancels the backend over a SECOND connection", async () => {
    const ac = new AbortController();
    // FETCH hangs until abort, then rejects (as a real cancelled FETCH would).
    fetchImpl = () =>
      new Promise((_resolve, reject) => {
        ac.signal.addEventListener("abort", () => reject(new Error("canceling statement")));
      });
    const connector = createPostgresConnector(BASE);
    const p = connector.executeSQL("SELECT * FROM big", ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // flush the second-connection cancel
    const cancel = executed.find((e) => /pg_cancel_backend/.test(e.sql));
    expect(cancel).toBeDefined();
    expect(cancel?.params).toEqual([4242]); // the captured backend pid
  });
});

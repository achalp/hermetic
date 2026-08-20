/**
 * Unit tests for the Snowflake and Databricks connectors.
 *
 * Both connectors lazy-load their SDK via `require()`. We use Vitest's
 * `vi.mock` to substitute fake SDKs so we can verify the contract
 * (testConnection, listTables, introspectAllTables, executeSQL, close)
 * without live credentials.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Snowflake mock ─────────────────────────────────────────────

interface FakeSnowflakeStatement {
  sqlText: string;
  complete: (err: Error | null, stmt: unknown, rows: Record<string, unknown>[] | undefined) => void;
}

const snowflakeQueryHandler = vi.fn<(sql: string) => Record<string, unknown>[]>();
let snowflakeConnected = false;
let snowflakeDestroyed = false;

vi.mock("snowflake-sdk", () => {
  const fake = {
    createConnection() {
      return {
        connect(cb: (err: Error | null) => void) {
          snowflakeConnected = true;
          setImmediate(() => cb(null));
        },
        execute(opts: FakeSnowflakeStatement) {
          try {
            const rows = snowflakeQueryHandler(opts.sqlText);
            setImmediate(() => opts.complete(null, {}, rows));
          } catch (err) {
            setImmediate(() => opts.complete(err as Error, {}, undefined));
          }
        },
        destroy(cb: () => void) {
          snowflakeDestroyed = true;
          setImmediate(cb);
        },
      };
    },
  };
  // Expose under both default and named for ESM/CJS interop
  return { ...fake, default: fake };
});

// ── Databricks mock ────────────────────────────────────────────

const databricksQueryHandler = vi.fn<(sql: string) => Record<string, unknown>[]>();
let databricksConnected = false;
let databricksClosed = false;

vi.mock("@databricks/sql", () => {
  class DBSQLClient {
    async connect() {
      databricksConnected = true;
      return this;
    }
    async openSession() {
      return {
        async executeStatement(sql: string) {
          const rows = databricksQueryHandler(sql);
          // executeSQL streams via fetchChunk/hasMoreRows; introspection uses
          // fetchAll. One chunk, then no more rows.
          let served = false;
          return {
            async fetchAll() {
              return rows;
            },
            async fetchChunk() {
              if (served) return [];
              served = true;
              return rows;
            },
            async hasMoreRows() {
              return false;
            },
            async close() {},
          };
        },
        async close() {},
      };
    }
    async close() {
      databricksClosed = true;
    }
  }
  return { DBSQLClient, default: DBSQLClient };
});

// Imports after mocks
import { createSnowflakeConnector } from "@/lib/warehouse/snowflake";
import { createDatabricksConnector } from "@/lib/warehouse/databricks";

beforeEach(() => {
  snowflakeQueryHandler.mockReset();
  databricksQueryHandler.mockReset();
  snowflakeConnected = false;
  snowflakeDestroyed = false;
  databricksConnected = false;
  databricksClosed = false;
});

// ── Snowflake tests ────────────────────────────────────────────

describe("Snowflake connector", () => {
  const config = {
    type: "snowflake" as const,
    account: "abc.us-east-1",
    user: "u",
    password: "p",
    database: "my_db",
    schema: "public",
    warehouse: "compute_wh",
    role: "analyst",
  };

  it("testConnection runs SELECT 1 against the configured account", async () => {
    snowflakeQueryHandler.mockReturnValue([{ "1": 1 }]);
    const c = createSnowflakeConnector(config);
    await c.testConnection();
    expect(snowflakeConnected).toBe(true);
    expect(snowflakeQueryHandler).toHaveBeenCalledWith("SELECT 1");
  });

  it("listTables returns rows from INFORMATION_SCHEMA.TABLES", async () => {
    snowflakeQueryHandler.mockImplementation((sql) => {
      if (/SELECT 1/.test(sql)) return [];
      return [
        { TABLE_NAME: "ORDERS", ROW_COUNT: 5000, COLUMN_COUNT: 7 },
        { TABLE_NAME: "CUSTOMERS", ROW_COUNT: 1000, COLUMN_COUNT: 4 },
      ];
    });
    const c = createSnowflakeConnector(config);
    const tables = await c.listTables();
    expect(tables).toHaveLength(2);
    expect(tables[0].schema).toBe("PUBLIC");
    expect(tables[0].name).toBe("ORDERS");
    expect(tables[0].row_count_estimate).toBe(5000);
  });

  it("introspectAllTables groups columns + PKs + FKs by table", async () => {
    snowflakeQueryHandler.mockImplementation((sql) => {
      if (
        /INFORMATION_SCHEMA\.COLUMNS/.test(sql) &&
        !/CONSTRAINT_COLUMN_USAGE/.test(sql) &&
        !/KEY_COLUMN_USAGE/.test(sql)
      ) {
        return [
          { TABLE_NAME: "ORDERS", COLUMN_NAME: "id", DATA_TYPE: "NUMBER", IS_NULLABLE: "NO" },
          { TABLE_NAME: "ORDERS", COLUMN_NAME: "amount", DATA_TYPE: "FLOAT", IS_NULLABLE: "YES" },
          {
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: "customer_id",
            DATA_TYPE: "NUMBER",
            IS_NULLABLE: "NO",
          },
        ];
      }
      if (/INFORMATION_SCHEMA\.TABLES/.test(sql)) {
        return [{ TABLE_NAME: "ORDERS", ROW_COUNT: 5000 }];
      }
      if (/PRIMARY KEY/.test(sql)) {
        return [{ TABLE_NAME: "ORDERS", COLUMN_NAME: "id" }];
      }
      if (/FOREIGN KEY/.test(sql)) {
        return [
          {
            TABLE_NAME: "ORDERS",
            COLUMN_NAME: "customer_id",
            REFERENCES_TABLE: "CUSTOMERS",
            REFERENCES_COLUMN: "id",
          },
        ];
      }
      return [];
    });

    const c = createSnowflakeConnector(config);
    const schemas = await c.introspectAllTables();
    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("ORDERS");
    expect(schemas[0].columns).toHaveLength(3);
    expect(schemas[0].columns[1]).toEqual({ name: "amount", type: "FLOAT", nullable: true });
    expect(schemas[0].primary_key).toEqual(["id"]);
    expect(schemas[0].foreign_keys).toEqual([
      { column: "customer_id", references_table: "CUSTOMERS", references_column: "id" },
    ]);
    expect(schemas[0].row_count_estimate).toBe(5000);
  });

  it("executeSQL formats results as CSV", async () => {
    snowflakeQueryHandler.mockReturnValue([
      { id: 1, name: "Alice", note: "hello, world" },
      { id: 2, name: "Bob", note: 'has "quotes"' },
    ]);
    const c = createSnowflakeConnector(config);
    const csv = await c.executeSQL("SELECT * FROM ORDERS");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("id,name,note");
    expect(lines[1]).toBe('1,Alice,"hello, world"');
    expect(lines[2]).toBe('2,Bob,"has ""quotes"""');
  });

  it("executeSQL returns empty string when no rows", async () => {
    snowflakeQueryHandler.mockReturnValue([]);
    const c = createSnowflakeConnector(config);
    const csv = await c.executeSQL("SELECT 1 WHERE FALSE");
    expect(csv).toBe("");
  });

  it("close destroys the connection", async () => {
    snowflakeQueryHandler.mockReturnValue([]);
    const c = createSnowflakeConnector(config);
    await c.testConnection();
    await c.close();
    expect(snowflakeDestroyed).toBe(true);
  });

  it("uppercases database and schema for INFORMATION_SCHEMA queries", async () => {
    snowflakeQueryHandler.mockReturnValue([]);
    const c = createSnowflakeConnector({
      ...config,
      database: "lower_case_db",
      schema: "lower_case_schema",
    });
    await c.listTables();
    const sql = snowflakeQueryHandler.mock.calls[0][0];
    expect(sql).toContain("LOWER_CASE_DB.INFORMATION_SCHEMA.TABLES");
    expect(sql).toContain("'LOWER_CASE_SCHEMA'");
  });

  it("propagates query errors", async () => {
    snowflakeQueryHandler.mockImplementation(() => {
      throw new Error("Object SNOWFLAKE_SAMPLE_DATA does not exist");
    });
    const c = createSnowflakeConnector(config);
    await expect(c.testConnection()).rejects.toThrow(/does not exist/);
  });
});

// ── Databricks tests ───────────────────────────────────────────

describe("Databricks connector", () => {
  const config = {
    type: "databricks" as const,
    serverHostname: "abc.cloud.databricks.com",
    httpPath: "/sql/1.0/warehouses/abc",
    token: "dapi-x",
    catalog: "samples",
    schema: "nyctaxi",
  };

  it("testConnection runs SELECT 1 via the SQL warehouse", async () => {
    databricksQueryHandler.mockReturnValue([{ "1": 1 }]);
    const c = createDatabricksConnector(config);
    await c.testConnection();
    expect(databricksConnected).toBe(true);
    expect(databricksQueryHandler).toHaveBeenCalledWith("SELECT 1");
  });

  it("listTables uses three-part names with catalog quoting", async () => {
    databricksQueryHandler.mockReturnValue([
      { table_name: "trips", column_count: 12 },
      { table_name: "stations", column_count: 5 },
    ]);
    const c = createDatabricksConnector(config);
    const tables = await c.listTables();
    expect(tables).toHaveLength(2);
    expect(tables[0].schema).toBe("samples.nyctaxi");
    expect(tables[0].name).toBe("trips");
    expect(tables[0].column_count).toBe(12);
    // row_count_estimate is 0 because Databricks does not expose it cheaply
    expect(tables[0].row_count_estimate).toBe(0);

    const sql = databricksQueryHandler.mock.calls[0][0];
    expect(sql).toContain("`samples`.information_schema.tables");
    expect(sql).toContain("'nyctaxi'");
  });

  it("introspectAllTables groups columns by table", async () => {
    databricksQueryHandler.mockReturnValue([
      { table_name: "trips", column_name: "trip_id", data_type: "BIGINT", is_nullable: "NO" },
      { table_name: "trips", column_name: "fare", data_type: "DECIMAL(10,2)", is_nullable: "YES" },
      { table_name: "stations", column_name: "id", data_type: "INT", is_nullable: "NO" },
    ]);
    const c = createDatabricksConnector(config);
    const schemas = await c.introspectAllTables();
    expect(schemas).toHaveLength(2);
    const trips = schemas.find((s) => s.name === "trips")!;
    expect(trips.columns).toHaveLength(2);
    expect(trips.columns[0]).toEqual({ name: "trip_id", type: "BIGINT", nullable: false });
    expect(trips.columns[1].nullable).toBe(true);
    expect(trips.schema).toBe("samples.nyctaxi");
  });

  it("executeSQL formats results as CSV", async () => {
    databricksQueryHandler.mockReturnValue([
      { trip_id: 1, fare: 12.5, pickup: "Midtown" },
      { trip_id: 2, fare: 7.25, pickup: 'East "Side"' },
    ]);
    const c = createDatabricksConnector(config);
    const csv = await c.executeSQL("SELECT * FROM trips LIMIT 2");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("trip_id,fare,pickup");
    expect(lines[1]).toBe("1,12.5,Midtown");
    expect(lines[2]).toBe('2,7.25,"East ""Side"""');
  });

  it("close shuts down the SDK client", async () => {
    databricksQueryHandler.mockReturnValue([]);
    const c = createDatabricksConnector(config);
    await c.testConnection();
    await c.close();
    expect(databricksClosed).toBe(true);
  });
});

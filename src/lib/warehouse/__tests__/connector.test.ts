import { describe, it, expect } from "vitest";
import { createConnector, type WarehouseConnector } from "@/lib/warehouse/connector";
import type { WarehouseConnectionConfig } from "@/lib/types";

/**
 * These tests exercise only the factory dispatch in `createConnector`.
 * Each connector constructor builds a driver/client object lazily (no network
 * connection happens until a method like testConnection/executeSQL is called),
 * so constructing the connector is side-effect-free and safe to test offline.
 * We never call any method that would perform I/O.
 */

function assertConnectorShape(c: WarehouseConnector) {
  expect(c).toBeTypeOf("object");
  expect(c.testConnection).toBeTypeOf("function");
  expect(c.listTables).toBeTypeOf("function");
  expect(c.introspectAllTables).toBeTypeOf("function");
  expect(c.executeSQL).toBeTypeOf("function");
  expect(c.close).toBeTypeOf("function");
}

const configs: Record<string, WarehouseConnectionConfig> = {
  postgresql: {
    type: "postgresql",
    host: "localhost",
    port: 5432,
    database: "db",
    user: "u",
    password: "p",
  },
  bigquery: {
    type: "bigquery",
    projectId: "my-project",
    dataset: "my_dataset",
    // Minimal but syntactically valid JSON — createBigQueryConnector parses this.
    credentialsJson: JSON.stringify({ type: "service_account", project_id: "my-project" }),
  },
  clickhouse: {
    type: "clickhouse",
    host: "localhost",
    port: 8123,
    database: "default",
    user: "default",
    password: "",
  },
  trino: {
    type: "trino",
    host: "localhost",
    port: 8080,
    user: "u",
    catalog: "cat",
    schema: "sch",
  },
  hive: {
    type: "hive",
    host: "localhost",
    port: 10000,
    database: "default",
    user: "u",
  },
  snowflake: {
    type: "snowflake",
    account: "acct.us-east-1",
    user: "u",
    password: "p",
    database: "db",
  },
  databricks: {
    type: "databricks",
    serverHostname: "abc-123.cloud.databricks.com",
    httpPath: "/sql/1.0/warehouses/abc123",
    token: "tok",
    catalog: "main",
  },
};

describe("warehouse/createConnector", () => {
  for (const [type, config] of Object.entries(configs)) {
    it(`returns a connector for type "${type}"`, () => {
      const connector = createConnector(config);
      assertConnectorShape(connector);
    });
  }

  it("BigQuery throws on invalid credentials JSON", () => {
    expect(() =>
      createConnector({
        type: "bigquery",
        projectId: "p",
        dataset: "d",
        credentialsJson: "not-json{",
      })
    ).toThrow(/credentials JSON/i);
  });

  it("returns undefined for an unknown/unsupported type (no default case)", () => {
    // The switch has no default; an unhandled type falls through to undefined.
    const result = createConnector({ type: "mysql" } as unknown as WarehouseConnectionConfig);
    expect(result).toBeUndefined();
  });
});

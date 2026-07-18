/**
 * Per-engine descriptor (ARCH-12). Exhaustiveness is enforced at the type
 * level (Record<WarehouseType, …>); these tests pin the behaviors that were
 * previously scattered switches — quoting, labels — so a descriptor edit
 * that would regress the SQL-gen prompt or the sample query fails here.
 */
import { describe, it, expect } from "vitest";
import { ENGINES, connectionLabel } from "@/lib/warehouse/engine-descriptor";
import type { WarehouseConnectionConfig } from "@/lib/types";

describe("ENGINES quoting", () => {
  it("renders prompt table names with each engine's convention", () => {
    expect(ENGINES.bigquery.promptTableName("proj.ds", "t")).toBe("`proj.ds.t`");
    expect(ENGINES.trino.promptTableName("cat.sch", "t")).toBe('"cat.sch"."t"');
    expect(ENGINES.databricks.promptTableName("cat.sch", "t")).toBe("`cat.sch`.`t`");
    expect(ENGINES.hive.promptTableName("db", "t")).toBe("`db`.`t`");
    // Snowflake stays unquoted so unquoted-uppercase identifiers resolve.
    expect(ENGINES.snowflake.promptTableName("SCH", "T")).toBe("SCH.T");
    expect(ENGINES.postgresql.promptTableName("public", "t")).toBe("public.t");
  });

  it("only BigQuery qualifies FK references", () => {
    const qualifying = Object.entries(ENGINES)
      .filter(([, e]) => e.qualifyFkRefs)
      .map(([k]) => k);
    expect(qualifying).toEqual(["bigquery"]);
  });

  it("escapes quote characters in sample queries (injection is blocked upstream, quoting must still not break)", () => {
    expect(ENGINES.postgresql.sampleQuery('sch."x"')).toBe('SELECT * FROM "sch.""x""" LIMIT 5');
    expect(ENGINES.clickhouse.sampleQuery("db.`x`")).toBe("SELECT * FROM `db.\\`x\\`` LIMIT 5");
    // Snowflake passes through unquoted (unquoted identifiers uppercase-fold).
    expect(ENGINES.snowflake.sampleQuery("DB.SCH.T")).toBe("SELECT * FROM DB.SCH.T LIMIT 5");
  });
});

describe("connectionLabel", () => {
  const cases: [WarehouseConnectionConfig, string][] = [
    [
      { type: "postgresql", host: "h", port: 5432, database: "d", user: "u", password: "p" },
      "PostgreSQL: h/d",
    ],
    [{ type: "bigquery", projectId: "p", dataset: "d", credentialsJson: "{}" }, "BigQuery: p.d"],
    [
      { type: "clickhouse", host: "h", port: 8123, database: "d", user: "u", password: "p" },
      "ClickHouse: h/d",
    ],
    [
      { type: "trino", host: "h", port: 8080, user: "u", catalog: "c", schema: "s" },
      "Trino: h/c.s",
    ],
    [{ type: "hive", host: "h", port: 10000, database: "d", user: "u" }, "Hive: h/d"],
    [
      { type: "snowflake", account: "a", user: "u", password: "p", database: "d" },
      "Snowflake: a/d",
    ],
    [
      { type: "databricks", serverHostname: "sh", httpPath: "/x", token: "t", catalog: "c" },
      "Databricks: sh/c",
    ],
  ];

  it("labels every engine's config (dedup key for saved connections)", () => {
    for (const [config, expected] of cases) {
      expect(connectionLabel(config)).toBe(expected);
    }
    // Sweep guard: every union member exercised.
    expect(new Set(cases.map(([c]) => c.type)).size).toBe(Object.keys(ENGINES).length);
  });
});

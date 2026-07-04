import { describe, it, expect } from "vitest";
import { __testing } from "@/lib/warehouse/sql-generation";

const { cleanSQL } = __testing;

describe("cleanSQL — leading-prose stripping", () => {
  it("drops a reasoning paragraph before the query (the 'Unexpected identifier I' bug)", () => {
    const raw =
      "I need to find the building with the greatest minimum distance. Given the size, I'll sample.\n\n" +
      "SELECT id FROM t WHERE x > 0 LIMIT 1";
    expect(cleanSQL(raw)).toBe("SELECT id FROM t WHERE x > 0 LIMIT 1");
  });

  it("slices from a leading WITH when prose precedes a CTE query", () => {
    const raw = "Here is the query:\n\nWITH cte AS (SELECT 1) SELECT * FROM cte";
    expect(cleanSQL(raw)).toBe("WITH cte AS (SELECT 1) SELECT * FROM cte");
  });

  it("is a no-op when the SQL already starts with SELECT / WITH", () => {
    expect(cleanSQL("SELECT 1")).toBe("SELECT 1");
    expect(cleanSQL("  WITH c AS (SELECT 1) SELECT * FROM c  ")).toBe(
      "WITH c AS (SELECT 1) SELECT * FROM c"
    );
  });

  it("still unwraps a fenced query and strips it of prose", () => {
    const raw = "```sql\nSELECT 2\n```";
    expect(cleanSQL(raw)).toBe("SELECT 2");
  });
});

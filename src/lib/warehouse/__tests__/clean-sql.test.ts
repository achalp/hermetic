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

  it("keeps only the first query when the model appends prose + a second query", () => {
    // The 'Expected end of input but got "This"' bug: query1, then reasoning,
    // then a second "smarter" query.
    const raw =
      "SELECT a, MIN(d) AS nn FROM t GROUP BY a ORDER BY nn DESC LIMIT 1\n\n" +
      "This is still a cross-join. Let me use a smarter approach.\n\n" +
      "SELECT a FROM (SELECT a, ROW_NUMBER() OVER (ORDER BY d) rn FROM t) WHERE rn = 1";
    expect(cleanSQL(raw)).toBe("SELECT a, MIN(d) AS nn FROM t GROUP BY a ORDER BY nn DESC LIMIT 1");
  });

  it("keeps a multi-block query whose blocks are SQL continuations", () => {
    const raw = "SELECT a, b\nFROM t\n\nWHERE a > 0\n\nORDER BY b\nLIMIT 10";
    expect(cleanSQL(raw)).toBe("SELECT a, b\nFROM t\n\nWHERE a > 0\n\nORDER BY b\nLIMIT 10");
  });

  it("does NOT mistake prose starting with 'With' for a WITH clause", () => {
    // The 'Unexpected floating point literal "2.5"' bug: pure reasoning, no SQL,
    // that happened to start with the English word "With".
    const raw =
      "With 2.5 billion rows, a global nearest-neighbor computation is impossible without bucketing. I'll use a spatial grid.";
    // No real statement → returned as-is (the prose-only guard then rejects it).
    expect(cleanSQL(raw)).toBe(raw);
  });

  it("still extracts a real WITH cte after leading prose", () => {
    const raw = "Here's the query.\n\nWITH c AS (SELECT 1 AS x) SELECT x FROM c";
    expect(cleanSQL(raw)).toBe("WITH c AS (SELECT 1 AS x) SELECT x FROM c");
  });
});

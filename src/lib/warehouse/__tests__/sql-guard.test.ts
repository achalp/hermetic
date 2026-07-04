import { describe, it, expect } from "vitest";
import { checkAggregateInputLimit } from "@/lib/warehouse/sql-guard";

describe("checkAggregateInputLimit", () => {
  it("flags the reported bug: unordered LIMIT feeding a nearest-neighbor aggregate", () => {
    const sql = `
      SELECT a_id, MIN(dist_meters) AS nearest
      FROM (
        SELECT a.id AS a_id, ST_DISTANCE(a.g, b.g) AS dist_meters
        FROM (SELECT id, g FROM building WHERE names IS NOT NULL LIMIT 500) a
        CROSS JOIN (SELECT id, g FROM building WHERE names IS NOT NULL LIMIT 500) b
        WHERE a.id != b.id
      )
      GROUP BY a_id ORDER BY nearest DESC LIMIT 1`;
    expect(checkAggregateInputLimit(sql)).toMatch(/CHANGES THE ANSWER/);
  });

  it("flags a bare LIMIT feeding a COUNT", () => {
    expect(
      checkAggregateInputLimit("SELECT count(*) FROM (SELECT id FROM t LIMIT 1000) s")
    ).not.toBeNull();
  });

  it("does NOT flag an ORDER BY … LIMIT top-N feeding an aggregate (intentional)", () => {
    // "average of the top 10 salaries" — the LIMIT is deterministic, not a sample.
    expect(
      checkAggregateInputLimit("SELECT avg(x) FROM (SELECT x FROM t ORDER BY x DESC LIMIT 10) s")
    ).toBeNull();
  });

  it("does NOT flag a final top-level output LIMIT on an aggregated result", () => {
    expect(
      checkAggregateInputLimit(
        "SELECT region, sum(rev) FROM t GROUP BY region ORDER BY sum(rev) DESC LIMIT 20"
      )
    ).toBeNull();
  });

  it("does NOT flag a non-aggregating query that just LIMITs its output", () => {
    expect(checkAggregateInputLimit("SELECT id, name FROM t WHERE x > 0 LIMIT 500")).toBeNull();
  });

  it("ignores LIMIT appearing inside a string literal", () => {
    expect(
      checkAggregateInputLimit("SELECT count(*) FROM t WHERE note = 'LIMIT 5 sample'")
    ).toBeNull();
  });

  it("does not match a column literally named limit", () => {
    expect(
      checkAggregateInputLimit("SELECT sum(amount) FROM (SELECT amount, limit_flag FROM t) s")
    ).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  checkAggregateInputLimit,
  checkUnboundedLargeJoin,
  assertReadOnlySql,
} from "@/lib/warehouse/sql-guard";

describe("assertReadOnlySql", () => {
  it("allows a single SELECT / WITH / EXPLAIN, incl. leading comments and a trailing semicolon", () => {
    expect(() => assertReadOnlySql("SELECT * FROM t LIMIT 5")).not.toThrow();
    expect(() => assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x;")).not.toThrow();
    expect(() => assertReadOnlySql("-- top customers\nSELECT id FROM c")).not.toThrow();
    expect(() => assertReadOnlySql("/* scan */ SELECT 1")).not.toThrow();
    expect(() => assertReadOnlySql("EXPLAIN SELECT 1")).not.toThrow();
  });

  it("rejects mutations (DROP/DELETE/UPDATE/INSERT/TRUNCATE/CREATE/GRANT)", () => {
    for (const sql of [
      "DROP TABLE users",
      "DELETE FROM orders WHERE 1=1",
      "UPDATE t SET x = 1",
      "INSERT INTO t VALUES (1)",
      "TRUNCATE TABLE t",
      "CREATE TABLE evil (x int)",
      "GRANT ALL ON db.* TO 'x'",
    ]) {
      expect(() => assertReadOnlySql(sql), sql).toThrow(/read-only/i);
    }
  });

  it("rejects multi-statement SQL (the classic '; DROP TABLE' tail)", () => {
    expect(() => assertReadOnlySql("SELECT 1; DROP TABLE users")).toThrow(/multi-statement/i);
  });

  it("is not fooled by keywords inside string literals", () => {
    expect(() =>
      assertReadOnlySql("SELECT * FROM t WHERE note = 'please DROP by; thanks'")
    ).not.toThrow();
  });

  // First-keyword-only checking was bypassable (code-quality-hardening review):
  // Postgres executes DML inside a CTE, and EXPLAIN ANALYZE runs the statement.
  it("rejects DML hidden inside a CTE (Postgres executes it)", () => {
    expect(() =>
      assertReadOnlySql("WITH d AS (DELETE FROM orders RETURNING *) SELECT count(*) FROM d")
    ).toThrow(/read-only/i);
    expect(() =>
      assertReadOnlySql("WITH u AS (UPDATE t SET x = 1 RETURNING id) SELECT * FROM u")
    ).toThrow(/read-only/i);
    expect(() =>
      assertReadOnlySql("WITH i AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM i")
    ).toThrow(/read-only/i);
  });

  it("rejects EXPLAIN ANALYZE (executes the statement) but allows plain EXPLAIN", () => {
    expect(() => assertReadOnlySql("EXPLAIN ANALYZE DELETE FROM orders")).toThrow();
    expect(() => assertReadOnlySql("EXPLAIN ANALYZE SELECT * FROM t")).toThrow(/EXPLAIN ANALYZE/);
    expect(() => assertReadOnlySql("EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM t")).toThrow(
      /EXPLAIN ANALYZE/
    );
    expect(() => assertReadOnlySql("EXPLAIN SELECT * FROM t")).not.toThrow();
    expect(() => assertReadOnlySql("EXPLAIN (FORMAT JSON) SELECT * FROM t")).not.toThrow();
  });

  it("rejects MERGE and other write keywords anywhere in the statement", () => {
    expect(() =>
      assertReadOnlySql("WITH s AS (SELECT 1) MERGE INTO t USING s ON t.id = s.id")
    ).toThrow(/MERGE/);
    expect(() => assertReadOnlySql("SELECT 1 FROM t WHERE f(x) > (VACUUM)")).toThrow(/read-only/i);
  });

  it("rejects a semicolon-free second write attempt smuggled after a SELECT", () => {
    // No `;` — relies purely on keyword position, which the old guard ignored.
    expect(() =>
      assertReadOnlySql("SELECT 1 FROM t UNION ALL SELECT 1 FROM final\nDROP TABLE t")
    ).toThrow(/DROP/);
    expect(() =>
      assertReadOnlySql("SELECT * INTO backup FROM orders CREATE INDEX i ON t (x)")
    ).toThrow(/read-only/i);
  });

  it("still allows legitimate SELECT / WITH aggregates over the hardened guard", () => {
    expect(() =>
      assertReadOnlySql(
        "WITH monthly AS (SELECT date_trunc('month', created_at) m, sum(rev) r FROM orders GROUP BY 1) " +
          "SELECT m, r FROM monthly ORDER BY m"
      )
    ).not.toThrow();
    // Quoted identifiers colliding with keywords are blanked by stripNoise.
    expect(() => assertReadOnlySql('SELECT "delete", "update" FROM audit_log')).not.toThrow();
    // Word-prefix collisions (created_at, updated_at) must not trip \b matching.
    expect(() =>
      assertReadOnlySql("SELECT created_at, updated_at, refreshed FROM t WHERE deleted = false")
    ).not.toThrow();
  });
});

const TABLES = [
  { name: "building", row_count_estimate: 2_500_000_000 },
  { name: "sic_codes", row_count_estimate: 1_200 },
  { name: "orders", row_count_estimate: 50_000_000 },
];
const THRESHOLD = 5_000_000;

describe("checkUnboundedLargeJoin", () => {
  it("flags a non-equi self-join over a large table (the nearest-neighbor bug)", () => {
    const sql = `
      SELECT b1.id, MIN(ST_DISTANCE(b1.geometry, b2.geometry)) AS nn
      FROM \`bigquery-public-data.overture_maps.building\` b1
      JOIN \`bigquery-public-data.overture_maps.building\` b2 ON b1.id != b2.id
      WHERE b1.bbox.xmin BETWEEN -25 AND -13
      GROUP BY b1.id ORDER BY nn DESC LIMIT 1`;
    expect(checkUnboundedLargeJoin(sql, TABLES, THRESHOLD)).toMatch(/O\(n²\)|bucket/i);
  });

  it("flags a CROSS JOIN of a large table", () => {
    const sql = "SELECT count(*) FROM orders a CROSS JOIN orders b WHERE a.id != b.id";
    expect(checkUnboundedLargeJoin(sql, TABLES, THRESHOLD)).not.toBeNull();
  });

  it("does NOT flag an equi-join between large tables (bounded by the key)", () => {
    const sql = "SELECT * FROM orders o JOIN building b ON o.building_id = b.id";
    expect(checkUnboundedLargeJoin(sql, TABLES, THRESHOLD)).toBeNull();
  });

  it("does NOT flag a non-equi join against a SMALL table", () => {
    // sic_codes is tiny; a range/non-equi join against it is cheap.
    const sql = "SELECT * FROM orders o JOIN sic_codes s ON o.sic > s.low";
    expect(checkUnboundedLargeJoin(sql, TABLES, THRESHOLD)).toBeNull();
  });

  it("does NOT flag a large table joined equi + inequality (still has an equality)", () => {
    const sql = "SELECT * FROM building a JOIN building b ON a.cell = b.cell AND a.id != b.id";
    expect(checkUnboundedLargeJoin(sql, TABLES, THRESHOLD)).toBeNull();
  });

  it("does NOT flag a plain single-table aggregate", () => {
    expect(checkUnboundedLargeJoin("SELECT count(*) FROM building", TABLES, THRESHOLD)).toBeNull();
  });
});

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

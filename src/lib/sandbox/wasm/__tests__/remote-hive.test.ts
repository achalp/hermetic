import { describe, it, expect } from "vitest";
import {
  encodeS3Key,
  buildHiveReadExpr,
  buildHiveAliases,
  budgetForFile,
} from "@/lib/sandbox/wasm/remote-hive";

const OBJECTS = [
  { key: "release/2026-07-22.0/theme=buildings/type=building/part-00000.parquet", size: 525687024 },
  { key: "release/2026-07-22.0/theme=buildings/type=building/part-00001.parquet", size: 516872041 },
];
const HOST = "overturemaps-us-west-2.s3.amazonaws.com";

describe("buildHiveAliases — one token per file, upstream never leaves the host", () => {
  it("mints a distinct token per file and hands the worker only same-origin URLs", () => {
    let n = 0;
    const aliases = buildHiveAliases(OBJECTS, HOST, () => `tok${++n}`);
    expect(aliases).toHaveLength(2);
    expect(aliases.map((a) => a.url)).toEqual(["/api/wasm-range/tok1", "/api/wasm-range/tok2"]);
    // The worker gets no host, no bucket, no key — only an opaque token URL.
    for (const a of aliases) {
      expect(a.url).not.toContain(HOST);
      expect(a.url).not.toContain("s3://");
      expect(a.url).not.toContain("amazonaws.com");
    }
  });

  it("resolves the real upstream URL host-side, leaving `=` UNencoded", () => {
    const seen: string[] = [];
    buildHiveAliases(OBJECTS, HOST, (url) => {
      seen.push(url);
      return "t";
    });
    expect(seen[0]).toBe(`https://${HOST}/${OBJECTS[0].key}`);
    // S3 treats theme%3Dbuildings as a DIFFERENT key: encoding the `=` is exactly
    // how the D18 spike got a 404 from a URL curl fetched fine.
    expect(seen[0]).toContain("theme=buildings");
    expect(seen[0]).not.toContain("%3D");
  });

  it("still percent-encodes characters that genuinely need it", () => {
    const seen: string[] = [];
    buildHiveAliases([{ key: "a b/c=1/d#e.parquet", size: 1 }], HOST, (u) => (seen.push(u), "t"));
    expect(seen[0]).toContain("a%20b");
    expect(seen[0]).toContain("c=1");
    expect(seen[0]).toContain("d%23e");
  });

  it("keeps hive path segments in the ALIAS so partition columns survive", () => {
    const aliases = buildHiveAliases(OBJECTS, HOST, () => "t");
    // If these became synthetic names, hive_partitioning=true would silently stop
    // producing `theme`/`type` and a GROUP BY on them would change meaning.
    expect(aliases[0].name).toContain("theme=buildings");
    expect(aliases[0].name).toContain("type=building");
  });
});

describe("buildHiveReadExpr — drops into the model's existing `VIEW data` pattern", () => {
  it("emits a parquet file list with hive partitioning on", () => {
    const aliases = buildHiveAliases(OBJECTS, HOST, () => "t");
    const expr = buildHiveReadExpr(aliases, true);
    expect(expr).toMatch(/^read_parquet\(\[/);
    expect(expr).toContain("hive_partitioning=true");
    expect(expr).toContain("theme=buildings");
    // The generated code does: CREATE OR REPLACE VIEW data AS SELECT * FROM <expr>
    expect(`CREATE OR REPLACE VIEW data AS SELECT * FROM ${expr}`).toContain("read_parquet([");
  });

  it("omits hive_partitioning for a flat multi-file source", () => {
    const aliases = buildHiveAliases(OBJECTS, HOST, () => "t");
    expect(buildHiveReadExpr(aliases, false)).not.toContain("hive_partitioning");
  });

  it("escapes single quotes so a key can never terminate the SQL literal", () => {
    const aliases = buildHiveAliases([{ key: "a/o'brien=1/p.parquet", size: 1 }], HOST, () => "t");
    const expr = buildHiveReadExpr(aliases, true);
    expect(expr).toContain("o''brien=1");
    // Balanced quotes: doubling is the only way a quote appears.
    expect((expr.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it("refuses to build an expression for an empty source rather than emit invalid SQL", () => {
    expect(() => buildHiveReadExpr([], true)).toThrow(/no files/i);
  });
});

describe("budgetForFile", () => {
  it("allows footers plus matching row groups, but not an unbounded whole-object pull", () => {
    expect(budgetForFile(525687024)).toBe(Math.ceil(525687024 / 2));
    expect(budgetForFile(525687024)).toBeLessThan(525687024);
  });
  it("floors small files so they stay readable", () => {
    expect(budgetForFile(1000)).toBe(8 * 1024 * 1024);
  });
});

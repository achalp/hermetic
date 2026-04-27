import { describe, it, expect, beforeEach } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  loadDbtManifest,
  applyDbtMetadata,
  lookupTableMeta,
  validateManifestPath,
  clearDbtManifestCache,
} from "@/lib/warehouse/dbt-metadata";
import type { WarehouseTableSchema } from "@/lib/types";

const MANIFEST_FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "data",
  "test-fixtures",
  "tier-1",
  "dbt-enrichment",
  "manifest.json"
);

describe("validateManifestPath", () => {
  it("rejects an empty path", async () => {
    const result = await validateManifestPath("");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-manifest filename", async () => {
    const result = await validateManifestPath("/tmp/wrong-file.json");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/manifest\.json/);
  });

  it("accepts a real manifest.json", async () => {
    const result = await validateManifestPath(MANIFEST_FIXTURE);
    expect(result.ok).toBe(true);
  });
});

describe("loadDbtManifest", () => {
  beforeEach(() => clearDbtManifestCache());

  it("indexes models and sources by db.schema.name", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);
    expect(index.modelCount).toBeGreaterThanOrEqual(4);
    expect(index.schemaVersion).toBe("v11");

    const customers = index.byKey.get("jaffle.analytics.customers");
    expect(customers).toBeDefined();
    expect(customers?.description).toContain("lifetime");
    expect(customers?.column_descriptions["customer_id"]).toContain("Surrogate primary key");
    expect(customers?.column_descriptions["lifetime_value"]).toContain("Sum of all order revenue");
  });

  it("indexes sources using their identifier", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);
    // Source resource_type with identifier "customers" should be reachable via "jaffle.raw.customers"
    const rawCustomers = index.byKey.get("jaffle.raw.customers");
    expect(rawCustomers).toBeDefined();
    expect(rawCustomers?.description).toContain("Raw customers");
  });

  it("falls back to schema.name lookup when database is missing", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);
    const meta = lookupTableMeta(index, undefined, "analytics", "orders");
    expect(meta).toBeDefined();
    expect(meta?.description).toContain("payment-method splits");
  });

  it("returns undefined for tables not in the manifest", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);
    const meta = lookupTableMeta(index, "jaffle", "analytics", "no_such_table");
    expect(meta).toBeUndefined();
  });

  it("caches by mtime; second call hits cache", async () => {
    const a = await loadDbtManifest(MANIFEST_FIXTURE);
    const b = await loadDbtManifest(MANIFEST_FIXTURE);
    expect(a).toBe(b); // same Map object identity (cached)
  });

  it("re-parses when manifest mtime changes", async () => {
    // Copy fixture to a tmp file, parse, mutate, re-parse — confirm fresh index
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dbt-test-"));
    try {
      const tmpPath = path.join(tmpDir, "manifest.json");
      const raw = await import("node:fs/promises").then((fs) =>
        fs.readFile(MANIFEST_FIXTURE, "utf-8")
      );
      await writeFile(tmpPath, raw, "utf-8");

      const first = await loadDbtManifest(tmpPath);
      expect(first.modelCount).toBeGreaterThanOrEqual(4);

      // Touch the file with a new mtime + slightly modified content
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(tmpPath, raw + "\n", "utf-8");

      const second = await loadDbtManifest(tmpPath);
      expect(second).not.toBe(first);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed JSON with a useful error", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dbt-test-"));
    try {
      const tmpPath = path.join(tmpDir, "manifest.json");
      await writeFile(tmpPath, "{ not valid json", "utf-8");
      await expect(loadDbtManifest(tmpPath)).rejects.toThrow(/not valid JSON/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("applyDbtMetadata", () => {
  beforeEach(() => clearDbtManifestCache());

  it("enriches table and column descriptions in-place", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);

    const tables: WarehouseTableSchema[] = [
      {
        schema: "analytics",
        name: "customers",
        columns: [
          { name: "customer_id", type: "BIGINT", nullable: false },
          { name: "lifetime_value", type: "NUMERIC", nullable: true },
          { name: "unmapped_column", type: "TEXT", nullable: true },
        ],
        row_count_estimate: 1000,
      },
      {
        schema: "analytics",
        name: "orders",
        columns: [
          { name: "order_id", type: "BIGINT", nullable: false },
          { name: "amount", type: "NUMERIC", nullable: true },
        ],
        row_count_estimate: 5000,
      },
    ];

    const enriched = applyDbtMetadata(tables, index, "jaffle");
    expect(enriched).toBe(2);
    expect(tables[0].description).toContain("lifetime aggregates");
    expect(tables[0].columns[0].description).toContain("Surrogate primary key");
    expect(tables[0].columns[1].description).toContain("revenue");
    expect(tables[0].columns[2].description).toBeUndefined(); // not in manifest
    expect(tables[1].description).toContain("payment-method");
  });

  it("leaves tables alone when the database does not match", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);

    const tables: WarehouseTableSchema[] = [
      {
        schema: "analytics",
        name: "customers",
        columns: [{ name: "customer_id", type: "BIGINT", nullable: false }],
        row_count_estimate: 0,
      },
    ];

    // Wrong database → falls back to schema.name match (which still works)
    const enriched = applyDbtMetadata(tables, index, "nonexistent_db");
    expect(enriched).toBe(1);
  });

  it("handles trino-style 'catalog.schema' schema field", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);

    const tables: WarehouseTableSchema[] = [
      {
        schema: "hive.analytics", // trino convention: catalog.schema
        name: "customers",
        columns: [{ name: "customer_id", type: "bigint", nullable: false }],
        row_count_estimate: 0,
      },
    ];

    const enriched = applyDbtMetadata(tables, index, "jaffle");
    expect(enriched).toBe(1);
    expect(tables[0].description).toBeDefined();
  });

  it("does not overwrite existing descriptions", async () => {
    const index = await loadDbtManifest(MANIFEST_FIXTURE);

    const tables: WarehouseTableSchema[] = [
      {
        schema: "analytics",
        name: "customers",
        description: "Existing description, do not clobber.",
        columns: [
          {
            name: "customer_id",
            type: "BIGINT",
            nullable: false,
            description: "Existing column description.",
          },
        ],
        row_count_estimate: 0,
      },
    ];

    applyDbtMetadata(tables, index, "jaffle");
    expect(tables[0].description).toBe("Existing description, do not clobber.");
    expect(tables[0].columns[0].description).toBe("Existing column description.");
  });
});

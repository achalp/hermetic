import { describe, it, expect } from "vitest";
import {
  sanitizeSheetName,
  buildWorkbookContext,
  buildRetryPrompt,
  buildRetryPromptMulti,
  buildCodeGenSystemPrompt,
  buildCodeGenUserPrompt,
} from "@/lib/llm/prompts";
import type { CSVSchema, CSVColumn, WorkbookManifest, SheetRelationship } from "@/lib/types";

// ── Fixtures ──────────────────────────────────────────────────────

function catColumn(name: string): CSVColumn {
  return {
    name,
    dtype: "string",
    null_count: 0,
    sample_values: ["a", "b"],
    meta: {
      kind: "categorical",
      distinct_count: 2,
      distinct_values: ["a", "b"],
      avg_length: 1,
      max_length: 1,
      min_length: 1,
      is_unique: false,
    },
  };
}

function schema(filename: string, columns: CSVColumn[], rowCount = 10): CSVSchema {
  return {
    csv_id: "id-" + filename,
    filename,
    row_count: rowCount,
    columns,
    sample_rows: [],
  };
}

// ── sanitizeSheetName ─────────────────────────────────────────────

describe("sanitizeSheetName", () => {
  it("replaces a space (single run) with one underscore", () => {
    expect(sanitizeSheetName("Q1 Sales")).toBe("Q1_Sales");
  });

  it("replaces multiple invalid chars and collapses runs of underscores", () => {
    // "/" and ":" are invalid; the second .replace collapses "__" → "_".
    expect(sanitizeSheetName("Sales/2024:Report")).toBe("Sales_2024_Report");
  });

  it("replaces dots (the regex does NOT keep them) while preserving dashes", () => {
    expect(sanitizeSheetName("data-1.parquet")).toBe("data-1_parquet");
  });

  it("returns empty string for empty input (no fallback applied)", () => {
    expect(sanitizeSheetName("")).toBe("");
  });

  it("does not truncate long names (no length cap is enforced)", () => {
    const long = "a".repeat(40);
    expect(sanitizeSheetName(long)).toBe(long);
  });
});

// ── geospatial guidance in the codegen prompt ─────────────────────

describe("buildCodeGenUserPrompt — geospatial guidance", () => {
  it("adds spatial guidance when a geometry column is present", () => {
    const s = schema("buildings.parquet", [catColumn("id"), catColumn("geometry")]);
    const prompt = buildCodeGenUserPrompt(s, "which building is most isolated?");
    expect(prompt).toContain("Geospatial analysis");
    expect(prompt).toContain("NEVER cast `::GEOGRAPHY`");
    expect(prompt).toContain("ST_Distance_Sphere");
    // GeoParquet geometry is already a GEOMETRY — use it directly, do NOT wrap.
    expect(prompt).toContain("ALREADY a GEOMETRY");
    expect(prompt).toContain("Do NOT wrap it in ST_GeomFromWKB");
    // Steers away from the O(n^2) self-join that timed out.
    expect(prompt).toContain("O(n^2)");
    // Scale/memory: engine-first, coords-only KD-tree, grid fallback, disclosure.
    expect(prompt).toContain("ENGINE-FIRST");
    expect(prompt).toContain("must contain ONLY numeric columns");
    expect(prompt).toContain("GRID self-join");
    expect(prompt).toContain('results["analysis_scope"]');
    // KD-tree must rank in meters, not distorted lon/lat degrees.
    expect(prompt).toContain("PROJECT TO METERS FIRST");
    expect(prompt).toContain("NEVER build the tree on unscaled lon/lat");
  });

  it("adds bbox-pushdown guidance when a bbox struct column is present", () => {
    const s = schema("buildings.parquet", [
      catColumn("id"),
      catColumn("geometry"),
      catColumn("bbox"),
    ]);
    const prompt = buildCodeGenUserPrompt(s, "buildings in a region");
    expect(prompt).toContain("bbox STRUCT column");
    expect(prompt).toContain("FILTER on the bbox struct");
    // Named-region + perf guidance that rode along with the bbox tip.
    expect(prompt).toContain("NAMED REGION = POLYGON, NOT A BOX");
    expect(prompt).toContain("NEVER reads the geometry column");
  });

  it("omits bbox guidance when there is no bbox column", () => {
    const s = schema("pts.parquet", [catColumn("id"), catColumn("geometry")]);
    const prompt = buildCodeGenUserPrompt(s, "isolated points");
    expect(prompt).toContain("Geospatial analysis");
    expect(prompt).not.toContain("bbox STRUCT column");
  });

  it("omits spatial guidance for non-geo data", () => {
    const s = schema("sales.csv", [catColumn("region"), catColumn("product")]);
    const prompt = buildCodeGenUserPrompt(s, "top products");
    expect(prompt).not.toContain("Geospatial analysis");
    expect(prompt).not.toContain("GEOGRAPHY");
  });

  it("does not duplicate spatial guidance for a GeoJSON upload (its own section handles geometry)", () => {
    const s: CSVSchema = {
      ...schema("map.geojson", [catColumn("name"), catColumn("geometry")]),
      has_geojson: true,
      geojson_geometry_type: "Polygon",
    };
    const prompt = buildCodeGenUserPrompt(s, "map it");
    expect(prompt).not.toContain("Geospatial analysis (spatial extension is loaded)");
    expect(prompt).toContain("GeoJSON Source");
  });
});

// ── buildWorkbookContext ──────────────────────────────────────────

describe("buildWorkbookContext", () => {
  it("includes sheet count, sheet names, row counts and file paths", () => {
    const manifest: WorkbookManifest = {
      sheets: [
        { name: "Orders", csvId: "c1", schema: schema("orders.csv", [catColumn("order_id")], 100) },
        { name: "Customers", csvId: "c2", schema: schema("cust.csv", [catColumn("cust_id")], 50) },
      ],
      relationships: [],
    };
    const paths = new Map([
      ["Orders", "/data/input.csv"],
      ["Customers", "/data/sheets/customers.csv"],
    ]);
    const out = buildWorkbookContext(manifest, "metadata", paths);

    expect(out).toContain("This workbook has 2 sheets.");
    expect(out).toContain("### File Paths");
    expect(out).toContain('- "Orders" → /data/input.csv');
    expect(out).toContain('- "Customers" → /data/sheets/customers.csv');
    expect(out).toContain("### Sheet: Orders (100 rows — file: /data/input.csv)");
    expect(out).toContain("### Sheet: Customers (50 rows — file: /data/sheets/customers.csv)");
    // Column metadata is rendered for each sheet in metadata mode.
    expect(out).toContain("order_id");
    expect(out).toContain("cust_id");
  });

  it("renders detected relationships above the confidence threshold", () => {
    const rel: SheetRelationship = {
      sourceSheet: "Orders",
      sourceColumn: "cust_id",
      sourceColumnIndex: 0,
      targetSheet: "Customers",
      targetColumn: "cust_id",
      targetColumnIndex: 0,
      matchType: "exact_name",
      confidence: 0.9,
      isPrimaryKeyCandidate: false,
      isForeignKeyCandidate: true,
    };
    const manifest: WorkbookManifest = {
      sheets: [
        { name: "Orders", csvId: "c1", schema: schema("orders.csv", [catColumn("cust_id")]) },
        { name: "Customers", csvId: "c2", schema: schema("cust.csv", [catColumn("cust_id")]) },
      ],
      relationships: [rel],
    };
    const out = buildWorkbookContext(manifest, "metadata");

    expect(out).toContain("### Detected Relationships");
    expect(out).toContain("Orders.cust_id");
    expect(out).toContain("Customers.cust_id");
    expect(out).toContain("exact_name");
    expect(out).toContain("confidence: 0.90");
    expect(out).toContain(", FK");
  });

  it("omits relationships below the 0.5 confidence threshold", () => {
    const rel: SheetRelationship = {
      sourceSheet: "A",
      sourceColumn: "x",
      sourceColumnIndex: 0,
      targetSheet: "B",
      targetColumn: "y",
      targetColumnIndex: 0,
      matchType: "value_overlap",
      confidence: 0.3,
      isPrimaryKeyCandidate: false,
      isForeignKeyCandidate: false,
    };
    const manifest: WorkbookManifest = {
      sheets: [
        { name: "A", csvId: "c1", schema: schema("a.csv", [catColumn("x")]) },
        { name: "B", csvId: "c2", schema: schema("b.csv", [catColumn("y")]) },
      ],
      relationships: [rel],
    };
    const out = buildWorkbookContext(manifest, "metadata");
    expect(out).toContain("### Detected Relationships");
    // The low-confidence relationship row itself is skipped.
    expect(out).not.toContain("A.x");
  });

  it("handles the empty-relationships case (no relationships section, no file paths)", () => {
    const manifest: WorkbookManifest = {
      sheets: [{ name: "Only", csvId: "c1", schema: schema("only.csv", [catColumn("c")]) }],
      relationships: [],
    };
    const out = buildWorkbookContext(manifest, "metadata");
    expect(out).toContain("This workbook has 1 sheets.");
    expect(out).not.toContain("### File Paths");
    expect(out).not.toContain("### Detected Relationships");
  });
});

// ── buildRetryPrompt / buildRetryPromptMulti ──────────────────────

describe("buildRetryPrompt", () => {
  it("embeds the original code and error, labelled as the previous code", () => {
    const out = buildRetryPrompt("print(broken)", "NameError: broken");
    expect(out).toContain("Your previous code failed. Fix it.");
    expect(out).toContain("### Your previous code");
    expect(out).toContain("print(broken)");
    expect(out).toContain("NameError: broken");
    expect(out).not.toContain("## Available Columns");
    expect(out).not.toContain("## Reflection");
  });

  it("includes a schema context block when a schema is provided", () => {
    const s = schema("data.csv", [catColumn("region")], 42);
    const out = buildRetryPrompt("code", "err", s);
    expect(out).toContain("## Available Columns");
    expect(out).toContain("Filename: data.csv (42 rows)");
    expect(out).toContain("- region (string)");
    expect(out).toContain("Use EXACTLY these column names");
  });
});

describe("buildRetryPromptMulti", () => {
  it("throws when given no prior attempts", () => {
    expect(() => buildRetryPromptMulti([])).toThrow(
      "buildRetryPromptMulti requires at least one prior attempt"
    );
  });

  it("numbers multiple attempts, marks the most recent, and adds a reflection block", () => {
    const out = buildRetryPromptMulti([
      { code: "v1", error: "e1" },
      { code: "v2", error: "e2" },
    ]);
    expect(out).toContain("### Attempt 1");
    expect(out).toContain("### Attempt 2 (most recent)");
    expect(out).toContain("v1");
    expect(out).toContain("v2");
    expect(out).toContain("e1");
    expect(out).toContain("e2");
    expect(out).toContain("## Reflection");
    expect(out).toContain("You have already tried 2 times.");
  });

  it("truncates very long code and error blocks", () => {
    const longCode = "x".repeat(5000);
    const longErr = "y".repeat(2000);
    const out = buildRetryPromptMulti([{ code: longCode, error: longErr }]);
    expect(out).toContain("# ...[truncated]");
    expect(out).toContain("[...truncated]");
    // Only the first 4000 code chars are kept.
    expect(out).not.toContain("x".repeat(4001));
  });
});

// ── Light coverage of the large prompt builders ───────────────────

describe("buildCodeGenSystemPrompt", () => {
  it("includes the core output-contract instructions", () => {
    const out = buildCodeGenSystemPrompt("metadata");
    expect(out).toContain("/data/input.csv");
    expect(out).toContain("/data/output.json");
    expect(out).toContain("Output ONLY the Python code.");
  });

  it("adds the metadata note in metadata mode and workbook layer when flagged", () => {
    const meta = buildCodeGenSystemPrompt("metadata", true);
    expect(meta).toContain("Column metadata (types, statistics");
    expect(meta).toContain("Excel workbook");
    const sample = buildCodeGenSystemPrompt("sample", false);
    expect(sample).not.toContain("Column metadata (types, statistics");
  });

  it("scales output scope to the chosen purpose (compute matches intent)", () => {
    const none = buildCodeGenSystemPrompt("metadata");
    expect(none).not.toContain("Output scope:");

    const brief = buildCodeGenSystemPrompt("metadata", false, undefined, "brief");
    expect(brief).toContain("Output scope:");
    expect(brief).toContain("MINIMUM");
    expect(brief).toContain("AT MOST ONE");

    const deep = buildCodeGenSystemPrompt("metadata", false, undefined, "deep-dive");
    expect(deep).toContain("exhaustive deep-dive");

    // Legacy ids resolve (executive-summary → brief).
    const legacy = buildCodeGenSystemPrompt("metadata", false, undefined, "executive-summary");
    expect(legacy).toContain("MINIMUM");
  });
});

describe("buildCodeGenUserPrompt", () => {
  it("includes the filename, row count, columns and question", () => {
    const s = schema("sales.csv", [catColumn("region")], 7);
    const out = buildCodeGenUserPrompt(s, "What is the trend?");
    expect(out).toContain("## CSV Schema");
    expect(out).toContain("Filename: sales.csv");
    expect(out).toContain("Rows: 7");
    expect(out).toContain("region");
    expect(out).toContain("## Question");
    expect(out).toContain("What is the trend?");
  });
});

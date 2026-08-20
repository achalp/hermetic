/**
 * The warehouse RESULT seam (storeWarehouseResult) — turns a connector's CSV
 * result into an analyzable source for BOTH query routes. Previously zero
 * coverage, yet it decides Parquet-vs-CSV materialization, stamps the schema,
 * flags the sampled/capped case, and emits the __warehouse_csv_id the client
 * needs for follow-ups. A regression here silently breaks warehouse follow-ups.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csv/storage", () => ({ storeCSV: vi.fn(async () => {}) }));
vi.mock("@/lib/parquet/materialize", () => ({ materializeCsvToParquet: vi.fn() }));
vi.mock("@/lib/diagnostics/run-diagnostics", () => ({ diagEvent: vi.fn() }));

import { storeWarehouseResult, countCsvRows } from "../materialize-result";
import { storeCSV } from "@/lib/csv/storage";
import { materializeCsvToParquet } from "@/lib/parquet/materialize";

const emitInto = () => {
  const lines: string[] = [];
  return { emit: (l: string) => lines.push(l), lines };
};
// A CSV comfortably over PARQUET_MATERIALIZE_THRESHOLD (100k rows).
const BIG = "c\n" + "1\n".repeat(100_001);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("countCsvRows", () => {
  it("counts data rows (newlines minus the header), never negative", () => {
    expect(countCsvRows("a,b\n1,2\n3,4\n")).toBe(2);
    expect(countCsvRows("")).toBe(0);
    expect(countCsvRows("only-header\n")).toBe(0);
  });
});

describe("storeWarehouseResult", () => {
  it("small pull → CSV path: schema stamped warehouse, stored, id emitted, not sampled", async () => {
    const { emit, lines } = emitInto();
    const r = await storeWarehouseResult({
      csvContent: "a,b\n1,2\n3,4\n",
      warehouseType: "postgresql",
      sandboxRuntime: "docker",
      emit,
    });
    expect(materializeCsvToParquet).not.toHaveBeenCalled();
    expect(r.parquetFile).toBeUndefined();
    expect(r.schema.source_type).toBe("warehouse");
    expect(r.schema.warehouse_type).toBe("postgresql");
    expect(r.sampled).toBe(false);
    expect(storeCSV).toHaveBeenCalledWith(r.csvId, "a,b\n1,2\n3,4\n", r.schema);
    // The client learns the fresh id via a state patch.
    const joined = lines.join("");
    expect(joined).toContain("/state/__warehouse_csv_id");
    expect(joined).toContain(r.csvId);
  });

  it("large pull on docker → Parquet path with the capped-sample warning", async () => {
    vi.mocked(materializeCsvToParquet).mockResolvedValue({
      schema: {
        csv_id: "x",
        filename: "f",
        row_count: 1_000_000,
        columns: [{ name: "c" }],
        sample_rows: [],
      },
      parquetPath: "/tmp/warehouse.parquet",
    } as never);
    const { emit } = emitInto();
    const r = await storeWarehouseResult({
      csvContent: BIG,
      warehouseType: "snowflake",
      sandboxRuntime: "docker",
      emit,
    });
    expect(materializeCsvToParquet).toHaveBeenCalledOnce();
    expect(r.parquetFile).toBe("/tmp/warehouse.parquet");
    expect(r.schema.source_type).toBe("warehouse");
    // row_count hit WAREHOUSE_MAX_ROWS → sampled, and the prompt says so.
    expect(r.sampled).toBe(true);
    expect(r.parquetContext).toContain("CAPPED SAMPLE");
    expect(r.parquetContext).toContain("/data/input.parquet");
  });

  it("Parquet materialization failure falls back to the CSV path (never throws)", async () => {
    vi.mocked(materializeCsvToParquet).mockRejectedValue(new Error("docker daemon down"));
    const { emit } = emitInto();
    const r = await storeWarehouseResult({
      csvContent: BIG,
      warehouseType: "trino",
      sandboxRuntime: "docker",
      emit,
    });
    expect(materializeCsvToParquet).toHaveBeenCalledOnce();
    expect(r.parquetFile).toBeUndefined(); // fell back
    expect(r.schema.source_type).toBe("warehouse");
    expect(storeCSV).toHaveBeenCalledWith(r.csvId, BIG, r.schema);
  });

  // The "non-docker runtime never materializes to Parquet" case was removed with
  // the non-docker runtimes — Docker is the only runtime and it materializes.
});

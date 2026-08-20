// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { DataRailContent } from "@/app/components/data-rail-content";

const { getWarehouseSample } = vi.hoisted(() => ({
  getWarehouseSample: vi.fn(async () => ({
    headers: ["id", "name"],
    rows: [["1", "West"]],
  })),
}));

vi.mock("@/app/lib/api", () => ({ getWarehouseSample }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DataRailContent", () => {
  it("renders a CSV source with schema, profile, and sample sections", () => {
    render(
      <DataRailContent
        sourceType="csv"
        sourceName="sales.csv"
        schema={[{ name: "region", type: "text", sample: "West" }]}
        allSchema={[{ name: "region", type: "text", sample: "West" }]}
        profileChips={["1000 rows", "3 columns"]}
        sampleColumns={["region"]}
        sampleRows={[["West"]]}
      />
    );
    expect(screen.getByText(/sales\.csv/)).toBeInTheDocument();
    expect(screen.getByText("SCHEMA")).toBeInTheDocument();
    expect(screen.getByText("PROFILE")).toBeInTheDocument();
    expect(screen.getByText("SAMPLE")).toBeInTheDocument();
  });

  it("renders an excel source with sheet tabs", () => {
    const onSheetSelect = vi.fn();
    render(
      <DataRailContent
        sourceType="excel"
        sourceName="book.xlsx"
        sheets={[{ name: "Sheet1", rows: 10 }]}
        onSheetSelect={onSheetSelect}
        activeItem="Sheet1"
      />
    );
    expect(screen.getByText(/book\.xlsx/)).toBeInTheDocument();
  });

  it("shows a refresh control and fires it for cache-backed sources", () => {
    const onRefreshSchema = vi.fn();
    render(
      <DataRailContent
        sourceType="csv"
        sourceName="remote.parquet"
        onRefreshSchema={onRefreshSchema}
      />
    );
    const btn = screen.getByLabelText("Refresh schema");
    btn.click();
    expect(onRefreshSchema).toHaveBeenCalled();
  });

  it("fetches a warehouse sample for the selected table", async () => {
    render(
      <DataRailContent
        sourceType="warehouse"
        sourceName="analytics"
        warehouseId="wh-1"
        tables={[{ name: "orders", rows: "1k" }]}
        warehouseSchemas={[
          {
            name: "orders",
            columns: [
              { name: "id", type: "INTEGER", nullable: false },
              { name: "amount", type: "FLOAT", nullable: true },
            ],
            row_count_estimate: 1000,
            primary_key: ["id"],
          },
        ]}
      />
    );
    await waitFor(() => expect(getWarehouseSample).toHaveBeenCalledWith("wh-1", "orders"));
  });
});

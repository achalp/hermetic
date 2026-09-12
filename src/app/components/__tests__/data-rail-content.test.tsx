// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("DataRailContent — an unprofiled manifest entity", () => {
  const unprofiled = {
    name: "division_area",
    columns: [
      { name: "geometry", description: "WKB polygon" },
      { name: "names", description: "" },
    ],
    description: "Administrative boundaries",
  };

  it("shows the catalog's DECLARED columns and offers to profile — no invented stats", () => {
    render(
      <DataRailContent
        sourceType="manifest"
        sourceName="Overture · 14 entities"
        // Stale props from the previously active entity: they must NOT render
        // under this entity's name.
        schema={[{ name: "stale", type: "text", sample: "x" }]}
        profileChips={["999 rows"]}
        sampleColumns={["stale"]}
        sampleRows={[["x"]]}
        tables={[{ name: "division_area", rows: "not profiled" }]}
        activeItem="division_area"
        unprofiledEntity={unprofiled}
        onProfileEntity={() => {}}
      />
    );
    expect(screen.getByText("COLUMNS (DECLARED)")).toBeInTheDocument();
    expect(screen.getByText("geometry")).toBeInTheDocument();
    expect(screen.getByText("WKB polygon")).toBeInTheDocument();
    expect(screen.getByText("Administrative boundaries")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Profile this table" })).toBeInTheDocument();
    // The previous entity's schema and sample are gone, not relabelled.
    expect(screen.queryByText("stale")).not.toBeInTheDocument();
    expect(screen.queryByText("999 rows")).not.toBeInTheDocument();
    expect(screen.queryByText("SAMPLE")).not.toBeInTheDocument();
  });

  it("the profile button runs the explicit action and reports progress", async () => {
    const onProfileEntity = vi.fn();
    const { rerender } = render(
      <DataRailContent
        sourceType="manifest"
        sourceName="Overture"
        tables={[{ name: "division_area", rows: "not profiled" }]}
        activeItem="division_area"
        unprofiledEntity={unprofiled}
        onProfileEntity={onProfileEntity}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Profile this table" }));
    expect(onProfileEntity).toHaveBeenCalledTimes(1);

    rerender(
      <DataRailContent
        sourceType="manifest"
        sourceName="Overture"
        tables={[{ name: "division_area", rows: "loading…" }]}
        activeItem="division_area"
        unprofiledEntity={unprofiled}
        onProfileEntity={onProfileEntity}
        isProfilingEntity
      />
    );
    const busy = screen.getByRole("button", { name: "Profiling…" });
    expect(busy).toBeDisabled();
  });

  it("falls back to the ordinary schema/profile/sample sections once profiled", () => {
    render(
      <DataRailContent
        sourceType="manifest"
        sourceName="Overture"
        schema={[{ name: "id", type: "number", sample: "1" }]}
        profileChips={["7 rows"]}
        sampleColumns={["id"]}
        sampleRows={[["1"]]}
        tables={[{ name: "division_area", rows: "7" }]}
        activeItem="division_area"
        unprofiledEntity={null}
      />
    );
    expect(screen.getByText("SCHEMA")).toBeInTheDocument();
    expect(screen.getByText("7 rows")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Profile this table" })).not.toBeInTheDocument();
  });
});

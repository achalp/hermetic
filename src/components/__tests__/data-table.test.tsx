// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { DataTableComponent } from "@/components/data-table";

afterEach(cleanup);

describe("DataTableComponent — record rows with mismatched headers", () => {
  // Reproduces the Seattle spec: object rows whose keys don't match the display
  // headers. "NN Distance (m)"/"Subtype"/"Class" resolve via snake-case, but
  // "Building ID" matches no field — the positional fallback maps it to the
  // record's first field (short_id) so the cell renders instead of going blank.
  const props = {
    columns: ["Building ID", "NN Distance (m)", "Subtype", "Class"],
    rows: [{ short_id: "9ed9527d", nn_distance_m: 671.4, subtype: "residential", class: "house" }],
  };

  it("fills a display-only header column from the record's field by position", () => {
    render(<DataTableComponent props={props} />);
    expect(screen.getByText("9ed9527d")).toBeInTheDocument();
    expect(screen.getByText("671.4")).toBeInTheDocument();
    expect(screen.getByText("residential")).toBeInTheDocument();
    expect(screen.getByText("house")).toBeInTheDocument();
  });

  it("does not steal a field another column already matched by name", () => {
    // "subtype" matches the 3rd column by name; the positional fallback for
    // "Building ID" must not also grab it. Only short_id (unclaimed) is used.
    render(<DataTableComponent props={props} />);
    // "residential" appears exactly once (under Subtype), not duplicated.
    expect(screen.getAllByText("residential")).toHaveLength(1);
  });
});

describe("DataTableComponent — delta columns", () => {
  const base = {
    columns: ["Metric", "Baseline", "Variant", "Δ"],
    rows: [
      ["Alpha", "53.86%", "53.96%", "0.10"],
      ["Beta", "44.55%", "44.24%", "-0.31"],
      ["Gamma", "7.59", "7.59", "0"],
    ],
  };

  it("prepends + and colors positive deltas green, negatives red, zero neutral", () => {
    render(<DataTableComponent props={{ ...base, delta_columns: ["Δ"] }} />);

    const pos = screen.getByText("+0.10");
    expect(pos).toBeInTheDocument();
    expect(pos.className).toContain("text-highlight-max");

    const neg = screen.getByText("-0.31");
    expect(neg.className).toContain("text-highlight-min");

    const zero = screen.getByText("0", { selector: "span" });
    expect(zero.className).toContain("text-t-secondary");
    expect(zero.className).not.toContain("text-highlight");
  });

  it("matches the delta column by header, case-insensitively", () => {
    render(
      <DataTableComponent
        props={{
          ...base,
          columns: ["Metric", "Baseline", "Variant", "Delta"],
          delta_columns: ["delta"],
        }}
      />
    );
    expect(screen.getByText("+0.10").className).toContain("text-highlight-max");
  });

  it("leaves non-delta numeric columns untouched (no + prefix)", () => {
    render(<DataTableComponent props={{ ...base, delta_columns: ["Δ"] }} />);
    // The "Baseline" 53.86% value must not get colored as a delta.
    const cell = screen.getByText("53.86%");
    expect(cell.className).not.toContain("text-highlight-max");
  });

  it("is a no-op when delta_columns is absent", () => {
    render(<DataTableComponent props={base} />);
    // Raw value, no + prefix, no delta coloring.
    const cell = screen.getByText("0.10");
    expect(cell.className).not.toContain("text-highlight-max");
    expect(within(document.body).queryByText("+0.10")).toBeNull();
  });
});

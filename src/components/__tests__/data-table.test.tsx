// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { DataTableComponent } from "@/components/data-table";

afterEach(cleanup);

describe("DataTableComponent — delta columns", () => {
  const base = {
    columns: ["Metric", "Google", "vendor", "Δ"],
    rows: [
      ["QCR", "53.86%", "53.96%", "0.10"],
      ["QTB", "44.55%", "44.24%", "-0.31"],
      ["GMV", "7.59", "7.59", "0"],
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
          columns: ["Metric", "Google", "vendor", "Delta"],
          delta_columns: ["delta"],
        }}
      />
    );
    expect(screen.getByText("+0.10").className).toContain("text-highlight-max");
  });

  it("leaves non-delta numeric columns untouched (no + prefix)", () => {
    render(<DataTableComponent props={{ ...base, delta_columns: ["Δ"] }} />);
    // The "Google" 53.86% value must not get colored as a delta.
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

import { describe, it, expect } from "vitest";
import { executePipeline, formatOutput } from "@/lib/data-transforms/client-pipeline";

/**
 * The matrix output feeds HeatMap / Surface3D, whose contract is Plotly's:
 * z[y][x] — the OUTER index walks y_labels, the inner walks x_labels
 * (heatmap-chart.tsx annotates z[i][j] over y then x). A pivot emits one row
 * per rowKey with a column per columnKey, so rowKey IS the y axis. Labelling
 * it the other way round shipped every pivot-fed heatmap transposed against
 * its own axes.
 */
describe("pivot → matrix orientation (the HeatMap contract)", () => {
  const rows = [
    { month: "2024-01", segment: "Enterprise", rate: 1.9 },
    { month: "2024-02", segment: "Enterprise", rate: 2.9 },
    { month: "2024-01", segment: "SMB", rate: 2.1 },
    { month: "2024-02", segment: "SMB", rate: 3.3 },
  ];

  it("rowKey becomes y_labels, columnKey becomes x_labels, z is z[y][x]", () => {
    const pivoted = executePipeline(
      rows,
      [{ op: "pivot", rowKey: "segment", columnKey: "month", valueKey: "rate", aggFn: "avg" }],
      {},
      []
    );
    const out = formatOutput(pivoted, { statePath: "/computed/m", format: "matrix" }) as {
      z: number[][];
      x_labels: string[];
      y_labels: string[];
    };
    expect(out.y_labels).toEqual(["Enterprise", "SMB"]);
    expect(out.x_labels).toEqual(["2024-01", "2024-02"]);
    // Dimensions must agree with the labels — the transposition bug produced
    // a z whose outer length matched x_labels instead.
    expect(out.z.length).toBe(out.y_labels.length);
    expect(out.z[0].length).toBe(out.x_labels.length);
    // And the cells land where their labels say.
    expect(out.z[out.y_labels.indexOf("SMB")][out.x_labels.indexOf("2024-02")]).toBe(3.3);
  });

  it("stays consistent when the axes have different cardinalities", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((m) => ({
      month: m,
      segment: "One",
      rate: 1,
    }));
    const pivoted = executePipeline(
      many,
      [{ op: "pivot", rowKey: "segment", columnKey: "month", valueKey: "rate", aggFn: "avg" }],
      {},
      []
    );
    const out = formatOutput(pivoted, { statePath: "/computed/m", format: "matrix" }) as {
      z: number[][];
      x_labels: string[];
      y_labels: string[];
    };
    expect(out.y_labels.length).toBe(1);
    expect(out.x_labels.length).toBe(6);
    expect(out.z.length).toBe(1);
    expect(out.z[0].length).toBe(6);
  });
});

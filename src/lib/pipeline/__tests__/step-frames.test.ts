import { describe, it, expect } from "vitest";
import { buildStepFrames, primaryFrameCsv, stepFramePath } from "@/lib/pipeline/step-frames";

describe("primaryFrameCsv", () => {
  it("returns the CSV of the largest tabular output", () => {
    expect(
      primaryFrameCsv({
        stepNo: 1,
        datasets: { main: [{ a: 1, b: 2 }], small: [] },
      })
    ).toBe("a,b\n1,2");
  });

  it("returns null when there is no tabular output", () => {
    expect(primaryFrameCsv({ stepNo: 1, datasets: {} })).toBeNull();
  });
});

describe("buildStepFrames", () => {
  it("exposes the largest dataset as /data/step_N.csv with a prompt note", () => {
    const { files, context } = buildStepFrames([
      {
        stepNo: 2,
        datasets: {
          small: [{ a: 1 }],
          main: [
            { region: "West", revenue: 100 },
            { region: "East", revenue: 200 },
          ],
        },
      },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(stepFramePath(2));
    expect(files[0].content).toBe("region,revenue\nWest,100\nEast,200");
    expect(context).toContain("Step 2");
    expect(context).toContain("/data/step_2.csv");
    expect(context).toContain("region, revenue");
  });

  it("falls back to chart_data arrays when no datasets", () => {
    const { files } = buildStepFrames([{ stepNo: 1, chart_data: { bars: [{ x: "a", y: 1 }] } }]);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("x,y\na,1");
  });

  it("escapes commas, quotes, and newlines in cell values", () => {
    const { files } = buildStepFrames([
      { stepNo: 1, datasets: { main: [{ name: 'a,"b"\nc', n: 1 }] } },
    ]);
    expect(files[0].content).toBe('name,n\n"a,""b""\nc",1');
  });

  it("skips sources with no tabular output and returns empty when nothing usable", () => {
    expect(buildStepFrames([{ stepNo: 1, datasets: {} }])).toEqual({ files: [], context: "" });
    expect(buildStepFrames([{ stepNo: 1, datasets: { empty: [] } }])).toEqual({
      files: [],
      context: "",
    });
  });

  it("produces one file per upstream source", () => {
    const { files } = buildStepFrames([
      { stepNo: 1, datasets: { main: [{ a: 1 }] } },
      { stepNo: 3, datasets: { main: [{ b: 2 }] } },
    ]);
    expect(files.map((f) => f.path)).toEqual([stepFramePath(1), stepFramePath(3)]);
  });
});

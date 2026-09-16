import { describe, it, expect } from "vitest";
import {
  auditComputedKeys,
  auditDatasetKeys,
  type PatchLike,
} from "@/lib/pipeline/computed-key-audit";

describe("auditComputedKeys", () => {
  it("flags a component that reads a computed key no output produces (Seattle bug)", () => {
    const patches: PatchLike[] = [
      // DataController produces only top_isolated + stats.
      {
        op: "add",
        path: "/elements/dc",
        value: {
          type: "DataController",
          props: {
            outputs: [
              { statePath: "/computed/top_isolated", pipeline: [] },
              { statePath: "/computed/stats", format: "stats" },
            ],
          },
        },
      },
      // Bar chart reads a produced key — fine.
      {
        op: "add",
        path: "/elements/bar",
        value: { type: "BarChart", props: { data: { $state: "/computed/top_isolated" } } },
      },
      // Table reads an UNPRODUCED key — the bug.
      {
        op: "add",
        path: "/elements/tbl",
        value: { type: "DataTable", props: { rows: { $state: "/computed/top_table_rows" } } },
      },
      // Map reads another UNPRODUCED key.
      {
        op: "add",
        path: "/elements/map",
        value: { type: "MapView", props: { markers: { $state: "/computed/map_markers" } } },
      },
    ];

    const audit = auditComputedKeys(patches);
    expect(audit.produced).toEqual(expect.arrayContaining(["top_isolated", "stats"]));
    expect(audit.referenced).toEqual(
      expect.arrayContaining(["top_isolated", "top_table_rows", "map_markers"])
    );
    expect(audit.unproduced.sort()).toEqual(["map_markers", "top_table_rows"]);
  });

  it("treats a non-empty computed seed as a producer", () => {
    const patches: PatchLike[] = [
      { op: "add", path: "/state/computed/seeded", value: [{ a: 1 }] },
      {
        op: "add",
        path: "/elements/t",
        value: { type: "DataTable", props: { rows: { $state: "/computed/seeded" } } },
      },
    ];
    expect(auditComputedKeys(patches).unproduced).toEqual([]);
  });

  it("treats an empty computed seed as NOT produced", () => {
    const patches: PatchLike[] = [
      { op: "add", path: "/state/computed/empty", value: [] },
      {
        op: "add",
        path: "/elements/t",
        value: { type: "DataTable", props: { rows: { $state: "/computed/empty" } } },
      },
    ];
    expect(auditComputedKeys(patches).unproduced).toEqual(["empty"]);
  });

  it("harvests producers + seeds from a bulk /state add", () => {
    const patches: PatchLike[] = [
      { op: "add", path: "/state", value: { computed: { revenue: [{ x: 1 }] } } },
      {
        op: "add",
        path: "/elements/s",
        value: { type: "StatCard", props: { value: { $state: "/computed/revenue/total" } } },
      },
    ];
    expect(auditComputedKeys(patches).unproduced).toEqual([]);
  });
});

describe("auditDatasetKeys", () => {
  const RUNTIME = ["main", "map_top_isolated_buildings", "seattle_top10_isolated_buildings"];

  it("flags a $state binding to a dataset name nothing produces (run 572ff50a)", () => {
    // The generative composer invented /datasets/isolated_markers for a
    // MapView and its table while the run produced the RUNTIME keys — both
    // components rendered blank with no error anywhere.
    const patches: PatchLike[] = [
      {
        op: "add",
        path: "/elements/map-view",
        value: { type: "MapView", props: { markers: { $state: "/datasets/isolated_markers" } } },
      },
      {
        op: "add",
        path: "/elements/table",
        value: { type: "DataTable", props: { rows: { $state: "/datasets/isolated_markers" } } },
      },
    ];
    const audit = auditDatasetKeys(patches, RUNTIME);
    expect(audit.unproduced).toEqual(["isolated_markers"]);
  });

  it("accepts bindings to runtime-injected dataset keys", () => {
    const patches: PatchLike[] = [
      {
        op: "add",
        path: "/elements/map-view",
        value: {
          type: "MapView",
          props: { markers: { $state: "/datasets/map_top_isolated_buildings" } },
        },
      },
    ];
    expect(auditDatasetKeys(patches, RUNTIME).unproduced).toEqual([]);
  });

  it("accepts datasets the spec seeds itself via a bulk /state add", () => {
    const patches: PatchLike[] = [
      { op: "add", path: "/state", value: { datasets: { custom: [{ x: 1 }] } } },
      {
        op: "add",
        path: "/elements/t",
        value: { type: "DataTable", props: { rows: { $state: "/datasets/custom" } } },
      },
    ];
    expect(auditDatasetKeys(patches, []).unproduced).toEqual([]);
  });

  it("accepts a direct /state/datasets/<key> seed but not an empty one", () => {
    const patches: PatchLike[] = [
      { op: "add", path: "/state/datasets/full", value: [{ x: 1 }] },
      { op: "add", path: "/state/datasets/empty", value: [] },
      {
        op: "add",
        path: "/elements/a",
        value: { type: "DataTable", props: { rows: { $state: "/datasets/full" } } },
      },
      {
        op: "add",
        path: "/elements/b",
        value: { type: "DataTable", props: { rows: { $state: "/datasets/empty" } } },
      },
    ];
    expect(auditDatasetKeys(patches, []).unproduced).toEqual(["empty"]);
  });
});

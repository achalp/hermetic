import { describe, it, expect } from "vitest";
import { auditComputedKeys, type PatchLike } from "@/lib/pipeline/computed-key-audit";

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

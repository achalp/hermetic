import { describe, it, expect } from "vitest";
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import type { PatchLine } from "@/lib/contracts/stream-state";

describe("assembleSpecFromPatches", () => {
  it("assembles root, elements, and state from a patch stream", () => {
    const patches: PatchLine[] = [
      { op: "add", path: "/root", value: "col" },
      { op: "add", path: "/elements/col", value: { type: "LayoutColumn", children: ["bar"] } },
      { op: "add", path: "/elements/bar", value: { type: "BarChart", props: { x_key: "a" } } },
      { op: "add", path: "/state", value: { filters: {} } },
      { op: "add", path: "/state/computed/top", value: [{ a: 1 }] },
    ];
    const spec = assembleSpecFromPatches(patches)!;
    expect(spec.root).toBe("col");
    expect((spec.elements.bar as { type: string }).type).toBe("BarChart");
    expect((spec.state as { computed: { top: unknown[] } }).computed.top).toEqual([{ a: 1 }]);
    expect((spec.state as { filters: unknown }).filters).toEqual({});
  });

  it("applies a nested element patch (/elements/<id>/props/...)", () => {
    const spec = assembleSpecFromPatches([
      { op: "add", path: "/root", value: "t" },
      { op: "add", path: "/elements/t", value: { type: "DataTable", props: { columns: [] } } },
      { op: "replace", path: "/elements/t/props/rows", value: { $state: "/computed/x" } },
    ])!;
    expect((spec.elements.t as { props: { rows: unknown } }).props.rows).toEqual({
      $state: "/computed/x",
    });
  });

  it("honors remove ops", () => {
    const spec = assembleSpecFromPatches([
      { op: "add", path: "/root", value: "r" },
      { op: "add", path: "/elements/r", value: { type: "X" } },
      { op: "add", path: "/elements/gone", value: { type: "Y" } },
      { op: "remove", path: "/elements/gone" },
    ])!;
    expect(spec.elements.r).toBeDefined();
    expect(spec.elements.gone).toBeUndefined();
  });

  it("returns null when no /root was ever set (nothing renderable)", () => {
    expect(assembleSpecFromPatches([{ op: "add", path: "/state/x", value: 1 }])).toBeNull();
  });
});

// @vitest-environment jsdom
/**
 * The pure spec-assembly logic in hooks.ts (flatToTree / buildSpecFromParts /
 * getTextFromParts) and the useBoundProp two-way binding — the renderer's tree
 * construction and stream-part replay, previously largely uncovered.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderHook, act } from "@testing-library/react";
import {
  flatToTree,
  buildSpecFromParts,
  getTextFromParts,
  useBoundProp,
  StateProvider,
  useStateValue,
} from "@/spec/react";
import { SPEC_DATA_PART_TYPE } from "@/spec/core/types";

describe("flatToTree", () => {
  it("assembles parent→children and finds the root (the parentless element)", () => {
    const spec = flatToTree([
      { key: "root", type: "Col", props: {}, children: [], visible: true },
      { key: "a", type: "Text", props: { t: 1 }, children: [], parentKey: "root", visible: true },
      { key: "b", type: "Text", props: { t: 2 }, children: [], parentKey: "root", visible: true },
    ]);
    expect(spec.root).toBe("root");
    expect(spec.elements.root.children).toEqual(["a", "b"]);
    expect(spec.elements.a.props).toEqual({ t: 1 });
  });
  it("an element with a missing parent stays in the map but attaches nowhere", () => {
    const spec = flatToTree([
      { key: "root", type: "Col", props: {}, children: [], visible: true },
      { key: "orphan", type: "Text", props: {}, children: [], parentKey: "ghost", visible: true },
    ]);
    expect(spec.root).toBe("root");
    expect(spec.elements.orphan).toBeDefined();
    expect(spec.elements.root.children).toEqual([]);
  });
});

describe("getTextFromParts", () => {
  it("keeps text parts, trims, drops empties, joins with blank lines", () => {
    expect(
      getTextFromParts([
        { type: "text", text: "  hello  " },
        { type: "data-foo", data: {} },
        { type: "text", text: "   " },
        { type: "text", text: "world" },
      ])
    ).toBe("hello\n\nworld");
  });
  it("returns '' when there is no text", () => {
    expect(getTextFromParts([{ type: "data-x", data: {} }])).toBe("");
  });
});

describe("buildSpecFromParts", () => {
  it("returns null when no spec data part is present", () => {
    expect(buildSpecFromParts([{ type: "text", text: "hi" }])).toBeNull();
  });
  it("replays a 'flat' payload into the spec", () => {
    const spec = buildSpecFromParts([
      {
        type: SPEC_DATA_PART_TYPE,
        data: {
          type: "flat",
          spec: { root: "r", elements: { r: { type: "Text", props: {}, children: [] } } },
        },
      },
    ]);
    expect(spec?.root).toBe("r");
    expect(spec?.elements.r.type).toBe("Text");
  });
  it("applies a 'patch' payload incrementally", () => {
    const spec = buildSpecFromParts([
      {
        type: SPEC_DATA_PART_TYPE,
        data: {
          type: "patch",
          patch: {
            op: "add",
            path: "/elements/x",
            value: { type: "Text", props: {}, children: [] },
          },
        },
      },
    ]);
    expect(spec?.elements.x).toBeDefined();
  });
  it("skips a malformed spec data part (payload missing spec)", () => {
    expect(buildSpecFromParts([{ type: SPEC_DATA_PART_TYPE, data: { type: "flat" } }])).toBeNull();
  });
});

describe("useBoundProp", () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <StateProvider initialState={{ form: { name: "init" } }}>{children}</StateProvider>
  );
  it("returns the passed value; setValue writes back to the bound path", () => {
    const { result } = renderHook(
      () => {
        const [value, setValue] = useBoundProp<string>("init", "/form/name");
        const current = useStateValue<string>("/form/name");
        return { value, setValue, current };
      },
      { wrapper }
    );
    expect(result.current.value).toBe("init");
    act(() => result.current.setValue("changed"));
    expect(result.current.current).toBe("changed");
  });
  it("setValue is a harmless no-op when the prop is not bound", () => {
    const { result } = renderHook(() => useBoundProp<string>("x", undefined), { wrapper });
    expect(result.current[0]).toBe("x");
    act(() => result.current[1]("y")); // must not throw
  });
});

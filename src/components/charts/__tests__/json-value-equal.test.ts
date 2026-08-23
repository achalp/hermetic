/**
 * jsonValueEqual (perf P8): the lazyChart memo comparator's replacement must
 * agree with the old `JSON.stringify(a) === JSON.stringify(b)` on every shape
 * that appears in chart props — if it ever returns a DIFFERENT verdict, the
 * memo either goes stale (missed update) or thrashes (needless nivo rebuild).
 */
import { describe, it, expect } from "vitest";
import { jsonValueEqual } from "@/components/charts/json-value-equal";

/** The old comparator's verdict, for parity checks. */
const stringifyEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("jsonValueEqual", () => {
  const CASES: Array<[string, unknown, unknown]> = [
    [
      "equal nested chart props",
      {
        data: [
          { x: 1, y: "a" },
          { x: 2, y: "b" },
        ],
        y_keys: ["y"],
        label_map: { y: "Y" },
      },
      {
        data: [
          { x: 1, y: "a" },
          { x: 2, y: "b" },
        ],
        y_keys: ["y"],
        label_map: { y: "Y" },
      },
    ],
    ["differing deep value", { data: [{ x: 1 }, { x: 2 }] }, { data: [{ x: 1 }, { x: 3 }] }],
    ["differing array length", { a: [1, 2] }, { a: [1, 2, 3] }],
    ["array vs object", { a: [1] }, { a: { 0: 1 } }],
    ["null vs missing key", { a: null }, {}],
    ["undefined-valued key dropped (JSON semantics)", { a: 1, b: undefined }, { a: 1 }],
    ["function-valued key dropped (JSON semantics)", { a: 1, b: () => {} }, { a: 1 }],
    ["NaN equals null (JSON emits null for both)", { v: NaN }, { v: null }],
    ["Infinity equals null (JSON semantics)", { v: Infinity }, { v: null }],
    ["key order matters (stringify is order-sensitive)", { a: 1, b: 2 }, { b: 2, a: 1 }],
    ["primitives", 1, 1],
    ["primitive mismatch", 1, "1"],
    ["empty structures", { a: [], b: {} }, { a: [], b: {} }],
  ];

  it.each(CASES)("agrees with the stringify comparator: %s", (_name, a, b) => {
    expect(jsonValueEqual(a, b)).toBe(stringifyEqual(a, b));
  });

  it("holds for a large equal dataset and rejects a one-cell change (early exit path)", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ x: i, y: i * 2, g: `g${i % 7}` }));
    const same = rows.map((r) => ({ ...r }));
    expect(jsonValueEqual({ data: rows }, { data: same })).toBe(true);
    same[4999] = { ...same[4999], y: -1 };
    expect(jsonValueEqual({ data: rows }, { data: same })).toBe(false);
  });
});

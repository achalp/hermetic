import { describe, it, expect } from "vitest";
import {
  readStreamState,
  findReservedStateKeyViolations,
  RESERVED_STATE_KEYS,
} from "@/lib/contracts/stream-state";

describe("readStreamState", () => {
  it("reads protocol state off a spec", () => {
    const spec = { root: "r", elements: {}, state: { __runId: "abc", __error: "boom" } };
    const s = readStreamState(spec as never);
    expect(s.__runId).toBe("abc");
    expect(s.__error).toBe("boom");
  });

  it("accepts a bare state record", () => {
    expect(readStreamState({ __runId: "x" }).__runId).toBe("x");
  });

  it("returns empty state for null/undefined/stateless specs", () => {
    expect(readStreamState(null)).toEqual({});
    expect(readStreamState(undefined)).toEqual({});
    expect(readStreamState({ root: "r", elements: {} } as never).__plan).toBeUndefined();
  });
});

describe("findReservedStateKeyViolations", () => {
  it("flags any __-prefixed key in composer-authored state", () => {
    expect(findReservedStateKeyViolations({ __plan: {}, datasets: {}, __custom: 1 })).toEqual([
      "__plan",
      "__custom",
    ]);
    expect(findReservedStateKeyViolations({ datasets: {} })).toEqual([]);
  });
});

describe("RESERVED_STATE_KEYS", () => {
  it("covers all 14 protocol keys", () => {
    expect(RESERVED_STATE_KEYS).toHaveLength(14);
    expect(new Set(RESERVED_STATE_KEYS).size).toBe(14);
  });
});

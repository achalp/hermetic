import { describe, it, expect } from "vitest";
import {
  readStreamState,
  findReservedStateKeyViolations,
  withoutHandoffState,
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
  it("covers all 15 protocol keys", () => {
    expect(RESERVED_STATE_KEYS).toHaveLength(15);
    expect(new Set(RESERVED_STATE_KEYS).size).toBe(15);
  });

  it("includes the __wasm_exec handoff key (webview live handoff, build log D6)", () => {
    expect(RESERVED_STATE_KEYS).toContain("__wasm_exec");
  });
});

describe("withoutHandoffState", () => {
  it("removes __wasm_exec (non-mutating) while keeping other state", () => {
    const spec = {
      root: "r",
      elements: {},
      state: { __runId: "x", __wasm_exec: { id: "1", code: "print(1)" } },
    };
    const stripped = withoutHandoffState(spec);
    expect(stripped.state).toEqual({ __runId: "x" });
    // original untouched (the caller's live spec must not change)
    expect(spec.state.__wasm_exec).toBeTruthy();
    // a fresh object, not the same reference
    expect(stripped).not.toBe(spec);
  });

  it("is a no-op (same reference) when there is no handoff state", () => {
    const spec = { root: "r", elements: {}, state: { __runId: "x" } };
    expect(withoutHandoffState(spec)).toBe(spec);
    const noState = { root: "r", elements: {} } as Record<string, unknown>;
    expect(withoutHandoffState(noState)).toBe(noState);
  });
});

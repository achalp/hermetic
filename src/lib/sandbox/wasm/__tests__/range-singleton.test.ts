import { describe, it, expect } from "vitest";
import { getRangeRegistry, getWarmCache } from "@/lib/sandbox/wasm/range-singleton";

/**
 * The process-wide range registry + warm cache (build log D18/D21).
 *
 * The file is three lines of wiring, but the property it exists to guarantee is
 * load-bearing and easy to break: the SIDECAR mints a token and the
 * `/api/wasm-range/[token]` ROUTE resolves it, and those compile into separate dev
 * module graphs. A per-module instance would 404 every range read with nothing in
 * the logs to explain it. That is what the globalThis pin buys, and what these pin.
 */

describe("range singleton", () => {
  it("hands back the SAME registry on every call", () => {
    // Not `toEqual` — identity is the whole point. Two structurally identical
    // registries with different token tables is exactly the bug.
    expect(getRangeRegistry()).toBe(getRangeRegistry());
  });

  it("a token minted through one call resolves through another", () => {
    const token = getRangeRegistry().register({
      url: "https://b.s3.amazonaws.com/part-0.parquet",
      allowlist: ["b.s3.amazonaws.com"],
      budgetBytes: 1000,
    });
    // The mint-here / resolve-there round trip, which is the real usage.
    expect(getRangeRegistry().resolve(token)?.url).toContain("part-0.parquet");
    expect(getRangeRegistry().release(token)).toBe(true);
  });

  it("mints UNGUESSABLE tokens — a token is a capability, not an id", () => {
    const reg = getRangeRegistry();
    const a = reg.register({ url: "https://h/a", allowlist: ["h"], budgetBytes: 1 });
    const b = reg.register({ url: "https://h/b", allowlist: ["h"], budgetBytes: 1 });
    // crypto.randomUUID, not a counter: a sequential token would let anything
    // that can reach localhost enumerate every live capability.
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    reg.release(a);
    reg.release(b);
  });

  it("hands back the same warm cache, kept SEPARATE from the registry", () => {
    expect(getWarmCache()).toBe(getWarmCache());
    // Derived data vs capability: a cache miss must never become an authorization
    // decision, so they are deliberately different objects.
    expect(getWarmCache() as unknown).not.toBe(getRangeRegistry() as unknown);
  });

  it("warms and clears through the shared cache", () => {
    const url = "https://b.s3.amazonaws.com/warm.parquet";
    getWarmCache().put(url, 100, Buffer.from("abcd"));
    expect(getWarmCache().get(url, 100, 103)?.toString()).toBe("abcd");
    getWarmCache().clearUrls([url]);
    expect(getWarmCache().get(url, 100, 103)).toBeUndefined();
  });
});

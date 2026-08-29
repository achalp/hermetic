import { describe, it, expect } from "vitest";
import { createRangeRegistry } from "@/lib/sandbox/wasm/range-registry";
import { parseContentRangeTotal } from "@/lib/sandbox/egress-fetch";

/**
 * The remote-range token registry (build log D18). These pin the property the
 * whole design rests on: the worker holds a CAPABILITY (a token bound to one
 * already-authorized URL) and may only choose byte offsets within it — it can
 * never name a destination, and it cannot transfer without bound.
 */

function reg(seed = 0) {
  let n = seed;
  return createRangeRegistry(() => `t${++n}`);
}

const SRC = {
  url: "https://bucket.s3.us-west-2.amazonaws.com/part-0.parquet",
  allowlist: ["bucket.s3.us-west-2.amazonaws.com"],
  budgetBytes: 1000,
};

describe("range registry — capability semantics", () => {
  it("register mints a token that resolves to the source; the URL is never caller-supplied", () => {
    const r = reg();
    const token = r.register({ ...SRC, runId: "run-1" });
    expect(token).toBe("t1");
    expect(r.resolve(token)?.url).toBe(SRC.url);
    expect(r.resolve(token)?.allowlist).toEqual(SRC.allowlist);
  });

  it("an unknown or released token resolves to undefined (the route 404s on it)", () => {
    const r = reg();
    const token = r.register(SRC);
    expect(r.resolve("nope")).toBeUndefined();
    expect(r.release(token)).toBe(true);
    expect(r.resolve(token)).toBeUndefined();
    expect(r.release(token)).toBe(false);
  });

  it("releaseRun drops every token the run owned, and only those", () => {
    const r = reg();
    r.register({ ...SRC, runId: "a" });
    r.register({ ...SRC, runId: "a" });
    const keep = r.register({ ...SRC, runId: "b" });
    expect(r.size()).toBe(3);
    expect(r.releaseRun("a")).toBe(2);
    expect(r.size()).toBe(1);
    expect(r.resolve(keep)).toBeDefined();
  });
});

describe("range registry — the budget is a ceiling, charged before bytes go out", () => {
  it("charges accumulate and the token is cut off at the budget, not after it", () => {
    const r = reg();
    const token = r.register({ ...SRC, budgetBytes: 100 });
    expect(r.charge(token, 60)).toBe(true);
    expect(r.spent(token)).toBe(60);
    // 60 + 50 would exceed 100 → refused, and NOT partially applied
    expect(r.charge(token, 50)).toBe(false);
    expect(r.spent(token)).toBe(60);
    // exactly reaching the budget is allowed
    expect(r.charge(token, 40)).toBe(true);
    expect(r.spent(token)).toBe(100);
    expect(r.charge(token, 1)).toBe(false);
  });

  it("a negative or non-finite charge cannot refund budget", () => {
    const r = reg();
    const token = r.register({ ...SRC, budgetBytes: 100 });
    expect(r.charge(token, 100)).toBe(true);
    expect(r.charge(token, -50)).toBe(false);
    expect(r.charge(token, Number.NaN)).toBe(false);
    expect(r.spent(token)).toBe(100);
    // still exhausted — the refund attempt bought nothing
    expect(r.charge(token, 1)).toBe(false);
  });

  it("charging an unknown token fails (no implicit registration)", () => {
    const r = reg();
    expect(r.charge("ghost", 1)).toBe(false);
  });
});

describe("parseContentRangeTotal", () => {
  it("extracts the object total the HEAD probe depends on", () => {
    // the exact shape S3 returned in the D18 spike
    expect(parseContentRangeTotal("bytes 0-3/525687024")).toBe(525687024);
    expect(parseContentRangeTotal("  bytes 525066711-525687023/525687024  ")).toBe(525687024);
  });

  it("returns null for anything it cannot trust", () => {
    expect(parseContentRangeTotal("")).toBeNull();
    expect(parseContentRangeTotal("bytes 0-3/*")).toBeNull();
    expect(parseContentRangeTotal("items 0-3/10")).toBeNull();
    expect(parseContentRangeTotal("bytes */525687024")).toBeNull();
  });
});

describe("warm cache — footer prefetch (D21)", () => {
  const U = "https://b.s3.amazonaws.com/part-0.parquet";

  it("serves a range fully covered by the warmed window", async () => {
    const { createWarmCache } = await import("@/lib/sandbox/wasm/range-registry");
    const c = createWarmCache();
    // Warmed the last 10 bytes of a 100-byte object: [90..99]
    c.put(U, 90, Buffer.from("0123456789"));
    expect(c.get(U, 90, 99)?.toString()).toBe("0123456789");
    expect(c.get(U, 95, 97)?.toString()).toBe("567");
  });

  it("MISSES rather than truncating when the range is only partly covered", async () => {
    const { createWarmCache } = await import("@/lib/sandbox/wasm/range-registry");
    const c = createWarmCache();
    c.put(U, 90, Buffer.from("0123456789"));
    // A partial hit served as if complete would corrupt DuckDB's read.
    expect(c.get(U, 85, 95)).toBeUndefined(); // starts before the window
    expect(c.get(U, 95, 105)).toBeUndefined(); // runs past the window
    expect(c.get("https://other/x", 90, 99)).toBeUndefined(); // different object
  });

  it("is keyed by url and clears per url", async () => {
    const { createWarmCache } = await import("@/lib/sandbox/wasm/range-registry");
    const c = createWarmCache();
    c.put(U, 0, Buffer.from("aa"));
    c.put("https://b/other.parquet", 0, Buffer.from("bb"));
    expect(c.size()).toBe(2);
    c.clearUrls([U]);
    expect(c.get(U, 0, 1)).toBeUndefined();
    expect(c.size()).toBe(1);
  });
});

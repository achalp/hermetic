import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { cacheGeneratedCode, getCachedCode } from "@/lib/pipeline/code-cache";

describe("code-cache", () => {
  // The module-level cache is keyed by csvId; use fresh ids per test plus a
  // clean slate by overwriting any reused keys.
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns undefined on a miss", () => {
    expect(getCachedCode("unknown-csv")).toBeUndefined();
  });

  it("returns {code, question} after caching", () => {
    cacheGeneratedCode("cc1", "print(1)", "what is one?");
    expect(getCachedCode("cc1")).toEqual({ code: "print(1)", question: "what is one?" });
  });

  it("does not leak cachedAt into the returned shape", () => {
    cacheGeneratedCode("cc-shape", "x", "y");
    const got = getCachedCode("cc-shape");
    expect(got && Object.keys(got).sort()).toEqual(["code", "question"]);
  });

  it("overwrites the prior entry for the same csvId", () => {
    cacheGeneratedCode("cc2", "v1", "q1");
    cacheGeneratedCode("cc2", "v2", "q2");
    expect(getCachedCode("cc2")).toEqual({ code: "v2", question: "q2" });
  });

  it("isolates entries per csvId", () => {
    cacheGeneratedCode("ccA", "codeA", "qA");
    cacheGeneratedCode("ccB", "codeB", "qB");
    expect(getCachedCode("ccA")).toEqual({ code: "codeA", question: "qA" });
    expect(getCachedCode("ccB")).toEqual({ code: "codeB", question: "qB" });
  });

  it("evicts entries older than the 10-minute TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    cacheGeneratedCode("cc-ttl", "stale", "q");
    expect(getCachedCode("cc-ttl")).toEqual({ code: "stale", question: "q" });

    // Just under the TTL — still present.
    vi.setSystemTime(new Date("2026-01-01T00:09:59Z"));
    expect(getCachedCode("cc-ttl")).toEqual({ code: "stale", question: "q" });

    // Past the TTL — evicted, returns undefined.
    vi.setSystemTime(new Date("2026-01-01T00:10:01Z"));
    expect(getCachedCode("cc-ttl")).toBeUndefined();
    // And the entry is deleted, so a subsequent read is still a miss.
    expect(getCachedCode("cc-ttl")).toBeUndefined();
  });
});

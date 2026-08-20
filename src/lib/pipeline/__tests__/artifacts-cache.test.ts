/**
 * The artifacts cache (sliding idle-TTL) — cache/get roundtrip with explicit
 * field projection, miss → undefined, and the active sweep.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheArtifacts,
  getCachedArtifacts,
  sweepExpiredArtifacts,
} from "@/lib/pipeline/artifacts-cache";
import type { CachedArtifacts } from "@/lib/contracts/investigation";

const artifacts = (): CachedArtifacts => ({
  code: "print(1)",
  question: "q",
  results: { total: 5 },
  chart_data: { bars: [{ x: 1 }] },
  datasets: {},
  execution_ms: 3,
});

beforeEach(() => sweepExpiredArtifacts()); // best-effort clear of stale entries

describe("artifacts-cache", () => {
  it("caches and returns the projected fields", () => {
    cacheArtifacts("csvA", artifacts());
    const got = getCachedArtifacts("csvA");
    expect(got?.code).toBe("print(1)");
    expect(got?.results).toEqual({ total: 5 });
    expect(got?.chart_data).toEqual({ bars: [{ x: 1 }] });
  });

  it("returns undefined for an unknown id", () => {
    expect(getCachedArtifacts("nope-" + Math.random())).toBeUndefined();
  });

  it("sweep returns a count and never throws on a fresh cache", () => {
    cacheArtifacts("csvB", artifacts());
    expect(typeof sweepExpiredArtifacts()).toBe("number");
    // fresh entry survives the sweep
    expect(getCachedArtifacts("csvB")).toBeDefined();
  });
});

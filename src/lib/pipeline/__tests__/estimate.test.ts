import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/pipeline/run-control", () => ({ reportProgress: vi.fn() }));

import { estimateRun } from "@/lib/pipeline/estimate";

describe("estimateRun", () => {
  it("small local data → quick", () => {
    const e = estimateRun({ rowCount: 10_000, isRemote: false, isLargeData: false });
    expect(e.bucket).toBe("quick");
  });

  it("billions of remote rows → very_long, with a stop reassurance", () => {
    const e = estimateRun({ rowCount: 2_500_000_000, isRemote: true, isLargeData: true });
    expect(e.bucket).toBe("very_long");
    expect(e.label).toMatch(/2\.5B rows/);
    expect(e.label).toMatch(/stop it anytime/i);
  });

  it("tens of millions remote → long", () => {
    const e = estimateRun({ rowCount: 13_700_000, isRemote: true, isLargeData: true });
    expect(e.bucket).toBe("long");
    expect(e.label).toMatch(/14M rows/);
  });

  it("large local parquet (not remote) → medium", () => {
    const e = estimateRun({ rowCount: 2_000_000, isRemote: false, isLargeData: true });
    expect(e.bucket).toBe("medium");
  });

  it("never returns a false-precise ETA (label is a range/qualitative)", () => {
    const e = estimateRun({ rowCount: 50_000_000, isRemote: true, isLargeData: true });
    // No "X minutes" hard promise — qualitative wording only.
    expect(e.label).not.toMatch(/\b\d+ minutes\b/);
  });
});

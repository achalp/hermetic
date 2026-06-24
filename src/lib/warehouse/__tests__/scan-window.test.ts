import { describe, it, expect } from "vitest";
import { extractDateEpoch, parsePartitionId, sizeScanWindow } from "@/lib/warehouse/scan-window";

const D = (s: string) => Date.parse(s + "T00:00:00Z");

describe("extractDateEpoch", () => {
  it("pulls the date out of date / datetime / timestamp string forms", () => {
    expect(extractDateEpoch("2023-10-01")).toBe(D("2023-10-01"));
    expect(extractDateEpoch("2023-10-01T12:34:56")).toBe(D("2023-10-01"));
    expect(extractDateEpoch("2023-10-01 12:34:56 UTC")).toBe(D("2023-10-01"));
    expect(extractDateEpoch("2023-10-01 12:34:56+00")).toBe(D("2023-10-01"));
  });
  it("returns null when there's no date", () => {
    expect(extractDateEpoch(null)).toBeNull();
    expect(extractDateEpoch("")).toBeNull();
    expect(extractDateEpoch("not a date")).toBeNull();
  });
});

describe("parsePartitionId", () => {
  it("parses day / month / year / hour partition ids", () => {
    expect(parsePartitionId("20231001")).toBe(D("2023-10-01"));
    expect(parsePartitionId("202310")).toBe(D("2023-10-01"));
    expect(parsePartitionId("2023")).toBe(D("2023-01-01"));
    expect(parsePartitionId("2023100109")).toBe(Date.parse("2023-10-01T09:00:00Z"));
  });
  it("returns null for non-date (integer-range / sentinel) ids", () => {
    expect(parsePartitionId("0")).toBeNull();
    expect(parsePartitionId("__NULL__")).toBeNull();
    expect(parsePartitionId("abc")).toBeNull();
  });
});

describe("sizeScanWindow", () => {
  it("returns null when the whole table fits the budget", () => {
    expect(sizeScanWindow(D("2023-01-01"), D("2023-12-31"), 500, 1000)).toBeNull();
  });

  it("returns null on degenerate ranges", () => {
    expect(sizeScanWindow(D("2023-06-01"), D("2023-06-01"), 5000, 1000)).toBeNull();
    expect(sizeScanWindow(D("2023-12-31"), D("2023-01-01"), 5000, 1000)).toBeNull();
    expect(sizeScanWindow(D("2023-01-01"), D("2023-12-31"), 0, 1000)).toBeNull();
  });

  it("sizes a recent window to ~budget rows, ending at the max", () => {
    // 365 days, 365_000 rows = 1000 rows/day. Budget 30_000 → ~30 days.
    const w = sizeScanWindow(D("2023-01-01"), D("2024-01-01"), 365_000, 30_000);
    expect(w).not.toBeNull();
    expect(w!.end).toBe("2024-01-01");
    expect(w!.start).toBe("2023-12-02"); // 30 days back
    expect(w!.estimatedRows).toBeGreaterThan(25_000);
    expect(w!.estimatedRows).toBeLessThan(35_000);
  });

  it("never returns a window wider than the data span", () => {
    // Budget far exceeds total but total > budget is false here, so it must be a
    // case where density is low: 10 days, 2000 rows, budget 1500 → ~7.5 days.
    const w = sizeScanWindow(D("2023-01-01"), D("2023-01-11"), 2000, 1500);
    expect(w).not.toBeNull();
    expect(D(w!.start)).toBeGreaterThanOrEqual(D("2023-01-01"));
    expect(w!.end).toBe("2023-01-11");
  });
});

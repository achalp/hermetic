/**
 * Retention policy (2026-08-05): CSV/remote entries NEVER idle-expire — this
 * is a local single-user tool, the index is tiny, and "Please re-upload"
 * after a lunch break was the worst UX in the product. These tests pin the
 * new invariants: entries survive arbitrary idle; only week-old ORPHAN
 * scratch files (post-restart leftovers not in the index) are reclaimed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { storeCSV, storeLocalFileRef, getStoredCSV, sweepExpiredCSVStore } from "@/lib/csv/storage";
import { CSV_TTL_MS } from "@/lib/constants";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const schema = { filename: "x.csv", row_count: 1, columns: [] } as unknown as CSVSchema;

let now = 0;

beforeEach(() => {
  now = 1_000_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => vi.restoreAllMocks());

describe("CSV store — retention (no idle expiry)", () => {
  it("an idle uploaded CSV survives far past the old 3h window", async () => {
    await storeCSV("idle-1", "a,b\n1,2\n", schema);
    now += CSV_TTL_MS * 20; // 60 hours idle — a long weekend
    const res = await sweepExpiredCSVStore();
    expect(res.expired).toBe(0);
    expect(getStoredCSV("idle-1")).toBeTruthy();
  });

  it("local bind-mounted refs survive too (unchanged behavior)", async () => {
    storeLocalFileRef("local-1", schema, "/data/events.parquet", 123, false);
    now += CSV_TTL_MS * 20;
    await sweepExpiredCSVStore();
    expect(getStoredCSV("local-1")).toBeTruthy();
  });

  it("reads keep working across the sweep — no eviction on read", async () => {
    await storeCSV("read-1", "a\n1\n", schema);
    now += CSV_TTL_MS + 60_000;
    expect(getStoredCSV("read-1")).toBeTruthy();
    now += CSV_TTL_MS * 5;
    expect(getStoredCSV("read-1")).toBeTruthy();
  });
});

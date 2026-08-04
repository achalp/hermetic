import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { storeCSV, storeLocalFileRef, getStoredCSV, sweepExpiredCSVStore } from "@/lib/csv/storage";
import { registerRun, endRun } from "@/lib/pipeline/run-control";
import { runWithRunId, getRunId } from "@/lib/run-context";
import { CSV_TTL_MS } from "@/lib/constants";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const schema = { filename: "x.csv", row_count: 1, columns: [] } as unknown as CSVSchema;

let now = 0;

beforeEach(() => {
  now = 1_000_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => vi.restoreAllMocks());

describe("CSV store — sliding idle TTL", () => {
  it("expires only after the idle window elapses since the LAST read, not upload", async () => {
    await storeCSV("slide-1", "a,b\n1,2\n", schema);

    // Read just before the window closes → slides the clock forward.
    now += CSV_TTL_MS - 60_000;
    expect(getStoredCSV("slide-1")).toBeTruthy();

    // Now well past the ORIGINAL upload + TTL, but only ~0 since the last read.
    now += CSV_TTL_MS - 60_000; // ≈ 2×TTL since upload
    await sweepExpiredCSVStore();
    expect(getStoredCSV("slide-1")).toBeTruthy(); // absolute-from-upload would have swept it
  });

  it("sweeps a genuinely idle entry once the window passes with no reads", async () => {
    await storeCSV("idle-1", "a\n1\n", schema);
    now += CSV_TTL_MS + 60_000;
    const res = await sweepExpiredCSVStore();
    expect(res.expired).toBeGreaterThanOrEqual(1);
    expect(getStoredCSV("idle-1")).toBeUndefined();
  });

  it("never expires a local (bind-mounted) file", async () => {
    storeLocalFileRef("local-1", schema, "/data/x.parquet", 123, false);
    now += CSV_TTL_MS * 10;
    await sweepExpiredCSVStore();
    expect(getStoredCSV("local-1")).toBeTruthy();
  });
});

describe("CSV store — pinned while its run is in-flight", () => {
  it("does not sweep a CSV whose owning run is still active, however long it runs", async () => {
    await storeCSV("pin-1", "a\n1\n", schema);

    let rid = "";
    await runWithRunId(async () => {
      rid = getRunId()!;
      registerRun(rid);
      getStoredCSV("pin-1"); // stamps ownerRunId = rid
    });

    // Long analysis: far past the idle window, but the run never ended.
    now += CSV_TTL_MS * 5;
    await sweepExpiredCSVStore();
    expect(getStoredCSV("pin-1")).toBeTruthy(); // pinned, survives

    // Run finishes → normal sliding TTL resumes; the last read above re-slid it,
    // so advance again before it can expire.
    endRun(rid);
    now += CSV_TTL_MS + 60_000;
    await sweepExpiredCSVStore();
    expect(getStoredCSV("pin-1")).toBeUndefined();
  });
});

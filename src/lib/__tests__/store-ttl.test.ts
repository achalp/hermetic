import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isIdleExpired, touch } from "@/lib/store-ttl";
import { registerRun, endRun } from "@/lib/pipeline/run-control";
import { runWithRunId, getRunId } from "@/lib/run-context";
import {
  storeWarehouse,
  getStoredWarehouse,
  sweepExpiredWarehouses,
  removeWarehouse,
} from "@/lib/warehouse/storage";
import {
  cacheArtifacts,
  getCachedArtifacts,
  sweepExpiredArtifacts,
} from "@/lib/pipeline/artifacts-cache";
import type { StoredWarehouse } from "@/lib/types";
import type { WarehouseConnector } from "@/lib/warehouse/connector";

let now = 0;
const TTL = 60 * 60 * 1000; // matches warehouse (CSV_TTL_MS=3h) — value here is local

beforeEach(() => {
  now = 1_000_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("store-ttl policy", () => {
  it("expires from the last access, not the base time (sliding)", () => {
    const e: { lastAccessedAt?: number; ownerRunId?: string } = {};
    const base = now;
    touch(e, now); // lastAccessedAt = now
    now += TTL - 1000;
    expect(isIdleExpired(e, base, TTL, now)).toBe(false);
    touch(e, now); // slide
    now += TTL - 1000;
    expect(isIdleExpired(e, base, TTL, now)).toBe(false); // 2×TTL since base, still alive
  });

  it("expires once the idle window passes with no touch", () => {
    const e = { lastAccessedAt: now };
    now += TTL + 1;
    expect(isIdleExpired(e, now, TTL, now)).toBe(true);
  });

  it("never expires while the owning run is active", async () => {
    const e: { lastAccessedAt?: number; ownerRunId?: string } = {};
    let rid = "";
    await runWithRunId(async () => {
      rid = getRunId()!;
      registerRun(rid);
      touch(e, now); // stamps ownerRunId = rid
    });
    now += TTL * 10;
    expect(isIdleExpired(e, e.lastAccessedAt!, TTL, now)).toBe(false); // pinned
    endRun(rid);
    expect(isIdleExpired(e, e.lastAccessedAt!, TTL, now)).toBe(true); // released
  });
});

const stubConnector = { close: async () => {} } as unknown as WarehouseConnector;

function mkWarehouse(id: string): StoredWarehouse {
  return {
    warehouseId: id,
    config: { type: "bigquery" } as StoredWarehouse["config"],
    tables: [],
    tableSchemas: [],
    createdAt: now,
  };
}

describe("warehouse store — sliding + active-run pin", () => {
  afterEach(() => {
    removeWarehouse("wh-slide");
    removeWarehouse("wh-pin");
  });

  it("keeps a connection alive across reads, expires only when idle", () => {
    storeWarehouse(mkWarehouse("wh-slide"), stubConnector);
    now += TTL; // CSV_TTL_MS is 3h; one hour is well within — read slides it
    expect(getStoredWarehouse("wh-slide")).toBeTruthy();
    now += 4 * 60 * 60 * 1000; // 4h idle past the last read → beyond 3h window
    expect(sweepExpiredWarehouses()).toBeGreaterThanOrEqual(1);
    expect(getStoredWarehouse("wh-slide")).toBeUndefined();
  });

  it("never drops a warehouse mid-run", async () => {
    storeWarehouse(mkWarehouse("wh-pin"), stubConnector);
    let rid = "";
    await runWithRunId(async () => {
      rid = getRunId()!;
      registerRun(rid);
      getStoredWarehouse("wh-pin"); // pins
    });
    now += 24 * 60 * 60 * 1000; // a full day of a long run
    expect(sweepExpiredWarehouses()).toBe(0);
    expect(getStoredWarehouse("wh-pin")).toBeTruthy();
    endRun(rid);
  });
});

describe("artifacts cache — sliding idle window", () => {
  it("survives a follow-up well past the old 10-minute window", () => {
    cacheArtifacts("art-1", {
      code: "x",
      question: "q",
      results: {},
      chart_data: {},
      datasets: {},
      execution_ms: 1,
    });
    now += 15 * 60 * 1000; // 15 min — would have expired under the old 10-min cap
    expect(getCachedArtifacts("art-1")).toBeTruthy();
    now += 2 * 60 * 60 * 1000; // 2h idle past that read → beyond the 1h window
    expect(sweepExpiredArtifacts()).toBeGreaterThanOrEqual(1);
    expect(getCachedArtifacts("art-1")).toBeUndefined();
  });
});

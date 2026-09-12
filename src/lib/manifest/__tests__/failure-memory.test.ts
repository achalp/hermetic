/**
 * Failure memory: a slow-failing entity must not re-burn the connect budget on
 * every reconnect. Observed: one entity failing at ~90s against a 60s budget
 * produced `attempted:1 ok:0 failed:1 skipped:13` on three consecutive
 * connects, while 11 healthy entities sat cached.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, { fingerprint: string; artifact: unknown }>();
vi.mock("@/lib/schema-cache", () => ({
  readSchemaCache: async (k: string) => store.get(k) ?? null,
  writeSchemaCache: async (k: string, fingerprint: string, artifact: unknown) => {
    store.set(k, { fingerprint, artifact });
  },
  deleteSchemaCache: async (k: string) => {
    store.delete(k);
  },
}));

import {
  recentFailure,
  rememberFailure,
  clearFailure,
  FAILURE_COOLDOWN_MS,
} from "@/lib/manifest/failure-memory";

const KEY = "parquet:s3://bucket/theme=x/**:{}";
const FP = "mhash:abc";

beforeEach(() => store.clear());

describe("failure memory", () => {
  it("remembers a failure and reports its reason during the cooldown", async () => {
    await rememberFailure(KEY, FP, "HTTP 403 from the object store", 1_000);
    expect(await recentFailure(KEY, FP, 1_000 + 60_000)).toMatch(/403/);
  });

  it("EXPIRES after the cooldown — a transient failure gets retried", async () => {
    await rememberFailure(KEY, FP, "timeout", 1_000);
    expect(await recentFailure(KEY, FP, 1_000 + FAILURE_COOLDOWN_MS)).toBeNull();
  });

  it("is fingerprint-scoped: changed data (or manifest) re-attempts immediately", async () => {
    await rememberFailure(KEY, FP, "boom", 1_000);
    expect(await recentFailure(KEY, "mhash:DIFFERENT", 1_000)).toBeNull();
  });

  it("clearFailure forgets it (a success, or an explicit retry)", async () => {
    await rememberFailure(KEY, FP, "boom", 1_000);
    await clearFailure(KEY);
    expect(await recentFailure(KEY, FP, 1_000)).toBeNull();
  });

  it("never collides with a cached SCHEMA under the same sourceKey", async () => {
    await rememberFailure(KEY, FP, "boom", 1_000);
    // The positive cache reads the bare sourceKey; the failure lives under a
    // namespaced key, so a schema lookup must not see the failure record.
    expect(store.has(KEY)).toBe(false);
    expect([...store.keys()][0]).toContain("extract-failure:");
  });
});

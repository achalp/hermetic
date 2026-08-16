import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getLearningExemplars,
  deleteLearningExemplar,
  getAudit,
  runAudit,
  getModelSettings,
} from "@/app/lib/api";

/**
 * The typed-client methods that replaced the last raw fetch() calls in the app
 * layer (ratchet: app-raw-fetch). Assert each hits the right URL/method and
 * preserves the tolerant-vs-throwing behavior of the call site it replaced.
 */
const calls: { url: string; init?: RequestInit }[] = [];
function mockFetch(response: { ok: boolean; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: response.ok,
        status: response.ok ? 200 : 500,
        json: async () => response.body,
      } as Response;
    })
  );
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("learning client", () => {
  it("getLearningExemplars returns the list on ok", async () => {
    mockFetch({ ok: true, body: { exemplars: [{ runId: "r1" }] } });
    const out = await getLearningExemplars();
    expect(calls[0].url).toBe("/api/learning");
    expect(out).toEqual([{ runId: "r1" }]);
  });

  it("getLearningExemplars is tolerant — returns [] on a non-ok response", async () => {
    mockFetch({ ok: false, body: {} });
    expect(await getLearningExemplars()).toEqual([]);
  });

  it("deleteLearningExemplar DELETEs the encoded id", async () => {
    mockFetch({ ok: true, body: {} });
    await deleteLearningExemplar("a b/c");
    expect(calls[0].url).toBe("/api/learning?exemplar=a%20b%2Fc");
    expect(calls[0].init?.method).toBe("DELETE");
  });
});

describe("audit client", () => {
  it("getAudit returns the audit on ok, null when absent", async () => {
    mockFetch({ ok: true, body: { audit: { model: "x", at: 1 } } });
    expect(await getAudit("hist-1")).toMatchObject({ model: "x" });
    expect(calls[0].url).toBe("/api/audit?history_id=hist-1");
  });

  it("getAudit is tolerant — returns null on a non-ok response", async () => {
    mockFetch({ ok: false, body: {} });
    expect(await getAudit("hist-1")).toBeNull();
  });

  it("runAudit POSTs and returns the audit", async () => {
    mockFetch({ ok: true, body: { audit: { model: "x", at: 2 } } });
    const out = await runAudit("hist-2");
    expect(calls[0].url).toBe("/api/audit");
    expect(calls[0].init?.method).toBe("POST");
    expect(out).toMatchObject({ model: "x" });
  });

  it("runAudit throws with the server error text on failure", async () => {
    mockFetch({ ok: false, body: { error: "Audit failed: no run" } });
    await expect(runAudit("hist-3")).rejects.toThrow("Audit failed: no run");
  });
});

describe("model settings client", () => {
  it("getModelSettings returns the raw view on ok, null on non-ok", async () => {
    mockFetch({ ok: true, body: { config: { models: { effort: "high" } } } });
    expect(await getModelSettings()).toMatchObject({ config: { models: { effort: "high" } } });

    mockFetch({ ok: false, body: {} });
    expect(await getModelSettings()).toBeNull();
  });
});

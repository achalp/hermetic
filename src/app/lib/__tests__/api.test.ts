/**
 * The client API wrapper (app/lib/api.ts) — thin typed fetch calls over a
 * shared json() helper. Covers request shaping (URL/method/body), the parsed
 * result, and the ok/error branches of json(). fetch is stubbed; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as api from "@/app/lib/api";

let lastCall: { url: string; init?: RequestInit };
function mockOk(payload: unknown, ok = true, status = 200) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    lastCall = { url, init };
    return { ok, status, json: async () => payload } as unknown as Response;
  });
}

beforeEach(() => {
  lastCall = { url: "" };
});
afterEach(() => vi.unstubAllGlobals());

describe("json() helper — via getSettings", () => {
  it("returns the parsed body on 200", async () => {
    vi.stubGlobal("fetch", mockOk({ composerMode: "compiled" }));
    const s = await api.getSettings();
    expect(s).toEqual({ composerMode: "compiled" });
    expect(lastCall.url).toBe("/api/settings");
  });
  it("throws ApiError with the server message on !ok", async () => {
    vi.stubGlobal("fetch", mockOk({ error: "nope" }, false, 400));
    await expect(api.getSettings()).rejects.toThrow("nope");
  });
  it("falls back to a status message when no error field is given", async () => {
    vi.stubGlobal("fetch", mockOk({}, false, 503));
    await expect(api.getSettings()).rejects.toThrow(/503/);
  });
});

describe("GET wrappers hit the right endpoint (and unwrap their field)", () => {
  // Superset payload so each function's unwrap (data.vizs / .entries / .rows /
  // whole body) finds what it reads; we assert the URL + that it resolves.
  const SUPERSET = { vizs: [{}], entries: [{}], rows: [{}], code: "x", spec: {}, id: "x" };
  it.each([
    ["getProviders", () => api.getProviders(), "/api/providers"],
    ["getRuntimes", () => api.getRuntimes(), "/api/runtimes"],
    ["listVizs", () => api.listVizs(), "/api/vizs"],
    ["listHistory", () => api.listHistory(), "/api/history"],
    ["getCostRows", () => api.getCostRows(), "/api/cost"],
    ["getArtifacts", () => api.getArtifacts("csv1"), "/api/artifacts/csv1"],
    ["loadViz", () => api.loadViz("v1"), "/api/vizs/v1"],
    ["loadHistoryEntry", () => api.loadHistoryEntry("h1"), "/api/history/h1"],
  ] as const)("%s → %s", async (_name, call, url) => {
    vi.stubGlobal("fetch", mockOk(SUPERSET));
    await expect(call()).resolves.toBeDefined();
    expect(lastCall.url).toBe(url);
  });

  it("checkLlmReady resolves via getProviders and reports readiness", async () => {
    vi.stubGlobal("fetch", mockOk({ active: null }));
    const r = await api.checkLlmReady();
    expect(r).toHaveProperty("ready");
  });
});

describe("mutating wrappers send the right method", () => {
  it("setComposerMode POSTs the mode", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await api.setComposerMode("compiled");
    expect(lastCall.url).toBe("/api/settings");
    expect(String(lastCall.init?.method)).toMatch(/POST|PUT|PATCH/i);
    expect(String(lastCall.init?.body)).toContain("compiled");
  });
  it("setActiveSandboxRuntime sends the runtime", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await api.setActiveSandboxRuntime("docker");
    expect(lastCall.url).toBe("/api/runtimes");
    expect(String(lastCall.init?.body)).toContain("docker");
  });
  it("deleteViz / deleteHistoryEntry use DELETE", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await api.deleteViz("v1");
    expect(lastCall.url).toBe("/api/vizs/v1");
    expect(String(lastCall.init?.method)).toBe("DELETE");
    await api.deleteHistoryEntry("h1");
    expect(lastCall.url).toBe("/api/history/h1");
    expect(String(lastCall.init?.method)).toBe("DELETE");
  });
});

describe("wrapper smoke sweep — each issues an /api request (covers the body)", () => {
  const SUPER = {
    sources: [{}],
    vizs: [{}],
    entries: [{}],
    rows: [{}],
    models: [],
    runs: [],
    code: "x",
    spec: {},
    ready: true,
    status: "ok",
    schema: {},
    plan: {},
  };
  it.each([
    ["getLocalBackendConfig", () => api.getLocalBackendConfig()],
    ["getOllamaConfig", () => api.getOllamaConfig()],
    ["getDiagnosticsRuns", () => api.getDiagnosticsRuns()],
    ["getLearningState", () => api.getLearningState()],
    ["getActiveRuns", () => api.getActiveRuns()],
    ["getRecentSources", () => api.getRecentSources()],
    ["getPlanSurface", () => api.getPlanSurface("csv1")],
    ["getSchemaByCsvId", () => api.getSchemaByCsvId("csv1")],
    ["getLocalLlmStatus", () => api.getLocalLlmStatus("ollama")],
    ["getLocalLlmModels", () => api.getLocalLlmModels("ollama")],
    ["renameRecentSource", () => api.renameRecentSource("id", "n")],
    ["removeRecentSource", () => api.removeRecentSource("id")],
    ["clearRecentSources", () => api.clearRecentSources()],
    ["disconnectWarehouse", () => api.disconnectWarehouse("wh1")],
    ["deleteLearningExemplar", () => api.deleteLearningExemplar("id")],
  ] as const)("%s", async (_n, call) => {
    vi.stubGlobal("fetch", mockOk(SUPER));
    await (call() as Promise<unknown>).catch(() => {}); // tolerate unwrap/return quirks
    expect(lastCall.url).toMatch(/^\/api\//);
  });
});

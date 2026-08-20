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

// A superset payload every remaining wrapper can unwrap a field from without
// tripping (data.cells / .questions / .schedules / .connections / .surface / …).
const MEGA = {
  cells: {},
  questions: ["q"],
  schedules: [{}],
  schedule: {},
  connections: [{}],
  models: [{}],
  runs: [{}],
  rows: [{}],
  entries: [{}],
  vizs: [{}],
  sources: [{}],
  exemplars: [{}],
  surface: {},
  audit: {},
  spec: {},
  plan: {},
  meta: {},
  artifacts: {},
  step: {},
  dependents: [],
  csv_id: "c1",
  schema: {},
  ok: true,
  status: "ready",
  os: "linux",
  arch: "x64",
};

describe("remaining wrappers hit the right endpoint (URL-asserted body-exec sweep)", () => {
  it.each([
    // Settings / providers / models
    [
      "putSettings",
      () => api.putSettings({ providers: { openaiModel: "m" } }),
      /^\/api\/settings$/,
    ],
    ["setActiveModels", () => api.setActiveModels({ codeGen: "m" }), /^\/api\/settings$/],
    ["setActiveProvider", () => api.setActiveProvider("openai"), /^\/api\/providers$/],
    ["getModelSettings", () => api.getModelSettings(), /^\/api\/settings$/],
    // Notebook compose
    [
      "composeNotebookCells",
      () => api.composeNotebookCells({ original_question: "q", steps: [] }),
      /^\/api\/query\/investigate\/compose-cell$/,
    ],
    // Upload
    ["uploadFile", () => api.uploadFile(new FormData()), /^\/api\/upload$/],
    ["selectSheet", () => api.selectSheet("x1", "Sheet1"), /^\/api\/upload\/select-sheet$/],
    ["selectWorkbook", () => api.selectWorkbook("x1"), /^\/api\/upload\/select-workbook$/],
    // Vizs
    ["saveViz", () => api.saveViz("c1", {}, "q"), /^\/api\/vizs\/save$/],
    ["rerunViz", () => api.rerunViz("v1", new File(["a"], "a.csv")), /^\/api\/vizs\/v1\/rerun$/],
    ["refreshViz", () => api.refreshViz("v1"), /^\/api\/vizs\/v1\/refresh$/],
    // Suggestions
    ["getSuggestions", () => api.getSuggestions({}), /^\/api\/suggest$/],
    [
      "getFollowUpSuggestions",
      () => api.getFollowUpSuggestions({ question: "q" }),
      /^\/api\/suggest$/,
    ],
    // History
    ["refreshHistoryEntry", () => api.refreshHistoryEntry("h1"), /^\/api\/history\/h1\/refresh$/],
    ["saveHistoryEntry", () => api.saveHistoryEntry("c1", {}, "q"), /^\/api\/history\/save$/],
    // Local files
    ["browseLocalFiles", () => api.browseLocalFiles("/tmp"), /^\/api\/local-files\/browse\?path=/],
    ["browseLocalFiles(no arg)", () => api.browseLocalFiles(), /^\/api\/local-files\/browse$/],
    ["selectLocalFile", () => api.selectLocalFile("/p", "file"), /^\/api\/local-files\/select$/],
    [
      "extractLocalSchema",
      () => api.extractLocalSchema("/p", "file"),
      /^\/api\/local-files\/schema$/,
    ],
    // Remote parquet
    [
      "extractRemoteParquetSchema",
      () => api.extractRemoteParquetSchema("s3://b/k.parquet"),
      /^\/api\/remote-parquet\/schema$/,
    ],
    // Plan editing
    ["patchPlan", () => api.patchPlan("c1", []), /^\/api\/plan$/],
    // Warehouse
    [
      "connectWarehouse",
      () => api.connectWarehouse({ type: "duckdb" } as never),
      /^\/api\/warehouse\/connect$/,
    ],
    [
      "getWarehouseSample",
      () => api.getWarehouseSample("wh1", "t1"),
      /^\/api\/warehouse\/sample\?warehouse_id=wh1&table=t1$/,
    ],
    [
      "bindDbtManifest",
      () => api.bindDbtManifest("wh1", "/m.json"),
      /^\/api\/warehouse\/dbt-metadata$/,
    ],
    ["unbindDbtManifest", () => api.unbindDbtManifest("wh1"), /^\/api\/warehouse\/dbt-metadata$/],
    ["getSavedConnections", () => api.getSavedConnections(), /^\/api\/warehouse\/presets$/],
    ["deleteSavedConnection", () => api.deleteSavedConnection("id"), /^\/api\/warehouse\/presets$/],
    [
      "renameSavedConnection",
      () => api.renameSavedConnection("id", "n"),
      /^\/api\/warehouse\/presets$/,
    ],
    // Stop / active
    ["stopAnalysis", () => api.stopAnalysis("r1"), /^\/api\/query\/stop$/],
    // Schedules
    ["listSchedules", () => api.listSchedules(), /^\/api\/vizs\/schedule$/],
    ["setSchedule", () => api.setSchedule("v1", "hourly", ["csv"]), /^\/api\/vizs\/schedule$/],
    ["deleteSchedule", () => api.deleteSchedule("v1"), /^\/api\/vizs\/schedule$/],
    ["runScheduleNow", () => api.runScheduleNow("v1"), /^\/api\/vizs\/schedule\/run-now$/],
    // Edit-and-rerun / investigate
    ["rerunCode", () => api.rerunCode("c1", "code"), /^\/api\/query\/rerun$/],
    [
      "rerunInvestigateStep",
      () => api.rerunInvestigateStep({ csvId: "c1", stepIndex: 0 }),
      /^\/api\/query\/investigate\/rerun-step$/,
    ],
    [
      "recomposeInvestigation",
      () => api.recomposeInvestigation("c1"),
      /^\/api\/query\/investigate\/recompose$/,
    ],
    [
      "saveNotebookLayout",
      () => api.saveNotebookLayout("c1", {} as never),
      /^\/api\/query\/investigate\/notebook$/,
    ],
    // Local LLM
    [
      "getLocalLlmRecommendations",
      () => api.getLocalLlmRecommendations("ollama", 5),
      /^\/api\/local-llm\/recommend\?backend=ollama&limit=5$/,
    ],
    ["getLocalLlmPlatform", () => api.getLocalLlmPlatform(), /^\/api\/local-llm\/platform$/],
    [
      "putLocalLlmConfig",
      () => api.putLocalLlmConfig({ backend: "ollama", enabled: true, activeModel: "m" }),
      /^\/api\/local-llm\/config$/,
    ],
    [
      "startLocalLlmServer",
      () => api.startLocalLlmServer({ backend: "ollama", model: "m" }),
      /^\/api\/local-llm\/start$/,
    ],
    ["stopLocalLlmServer", () => api.stopLocalLlmServer("ollama"), /^\/api\/local-llm\/stop$/],
    [
      "deleteLocalLlmModel",
      () => api.deleteLocalLlmModel({ backend: "ollama", model: "m" }),
      /^\/api\/local-llm\/delete$/,
    ],
    // Learning / audit
    ["getLearningExemplars", () => api.getLearningExemplars(), /^\/api\/learning$/],
    ["getAudit", () => api.getAudit("h1"), /^\/api\/audit\?history_id=h1$/],
    ["runAudit", () => api.runAudit("h1"), /^\/api\/audit$/],
  ] as const)("%s → %s", async (_n, call, urlRe) => {
    vi.stubGlobal("fetch", mockOk(MEGA));
    await (call() as Promise<unknown>).catch(() => {});
    expect(lastCall.url).toMatch(urlRe);
  });
});

describe("mutating wrappers carry the right method + body", () => {
  it("putSettings PUTs the update", async () => {
    vi.stubGlobal("fetch", mockOk(MEGA));
    await api.putSettings({ providers: { openaiModel: "gpt" } });
    expect(String(lastCall.init?.method)).toBe("PUT");
    expect(String(lastCall.init?.body)).toContain("gpt");
  });
  it("setActiveProvider PUTs the provider", async () => {
    vi.stubGlobal("fetch", mockOk({ active: "openai", activeLabel: "OpenAI" }));
    const r = await api.setActiveProvider("openai");
    expect(String(lastCall.init?.method)).toBe("PUT");
    expect(String(lastCall.init?.body)).toContain("openai");
    expect(r.active).toBe("openai");
  });
  it("saveViz POSTs csvId + question", async () => {
    vi.stubGlobal("fetch", mockOk({ meta: {} }));
    await api.saveViz("csv9", { a: 1 }, "why?");
    expect(String(lastCall.init?.method)).toBe("POST");
    expect(String(lastCall.init?.body)).toContain("csv9");
    expect(String(lastCall.init?.body)).toContain("why?");
  });
  it("setSchedule returns the unwrapped schedule", async () => {
    vi.stubGlobal("fetch", mockOk({ ok: true, schedule: { vizId: "v1", cadence: "hourly" } }));
    const s = await api.setSchedule("v1", "hourly", ["csv"]);
    expect(s).toMatchObject({ vizId: "v1" });
    expect(String(lastCall.init?.method)).toBe("POST");
  });
  it("deleteSchedule uses DELETE and sends the vizId", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await api.deleteSchedule("v7");
    expect(String(lastCall.init?.method)).toBe("DELETE");
    expect(String(lastCall.init?.body)).toContain("v7");
  });
  it("unbindDbtManifest uses DELETE", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await api.unbindDbtManifest("wh1");
    expect(String(lastCall.init?.method)).toBe("DELETE");
  });
  it("patchPlan PATCHes the mutations", async () => {
    vi.stubGlobal("fetch", mockOk({ spec: {}, plan: {} }));
    await api.patchPlan("csvX", [{ op: "hide" } as never], "hist1");
    expect(String(lastCall.init?.method)).toBe("PATCH");
    expect(String(lastCall.init?.body)).toContain("csvX");
    expect(String(lastCall.init?.body)).toContain("hist1");
  });
});

describe("unwrap-and-return correctness on a few field extractors", () => {
  it("composeNotebookCells returns data.cells", async () => {
    vi.stubGlobal("fetch", mockOk({ cells: { "0": { kind: "x" } } }));
    const cells = await api.composeNotebookCells({ original_question: "q", steps: [] });
    expect(cells).toEqual({ "0": { kind: "x" } });
  });
  it("getSuggestions returns data.questions (empty on missing)", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await expect(api.getSuggestions({})).resolves.toEqual([]);
  });
  it("listSchedules returns data.schedules ?? []", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    await expect(api.listSchedules()).resolves.toEqual([]);
  });
  it("getSavedConnections returns data.connections", async () => {
    vi.stubGlobal("fetch", mockOk({ connections: [{ id: "a" }] }));
    await expect(api.getSavedConnections()).resolves.toEqual([{ id: "a" }]);
  });
  it("getLearningExemplars is tolerant — [] on non-ok", async () => {
    vi.stubGlobal("fetch", mockOk({ error: "x" }, false, 500));
    await expect(api.getLearningExemplars()).resolves.toEqual([]);
  });
  it("getAudit is tolerant — null on non-ok, unwraps data.audit on ok", async () => {
    vi.stubGlobal("fetch", mockOk({}, false, 404));
    await expect(api.getAudit("h1")).resolves.toBeNull();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", mockOk({ audit: { verdict: "ok" } }));
    await expect(api.getAudit("h1")).resolves.toEqual({ verdict: "ok" });
  });
  it("runAudit throws when the body lacks an audit", async () => {
    vi.stubGlobal("fetch", mockOk({ error: "boom" }, false, 500));
    await expect(api.runAudit("h1")).rejects.toThrow("boom");
  });
  it("getModelSettings returns null on non-ok", async () => {
    vi.stubGlobal("fetch", mockOk({}, false, 500));
    await expect(api.getModelSettings()).resolves.toBeNull();
  });
});

describe("binary/header wrappers (blob + response headers)", () => {
  function mockBlob(headers: Record<string, string>, ok = true, status = 200) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      lastCall = { url, init };
      return {
        ok,
        status,
        headers: { get: (k: string) => headers[k] ?? null },
        blob: async () => ({ size: 3 }) as Blob,
        json: async () => ({}),
      } as unknown as Response;
    });
  }

  it("exportInteractiveHtml returns blob + parsed headers", async () => {
    vi.stubGlobal(
      "fetch",
      mockBlob({
        "Content-Disposition": 'attachment; filename="report.html"',
        "X-Hermetic-Export-Bundle": "compact",
        "X-Hermetic-Export-Bytes": "42",
      })
    );
    const r = await api.exportInteractiveHtml({ a: 1 }, "My Q");
    expect(lastCall.url).toBe("/api/export-html");
    expect(String(lastCall.init?.method)).toBe("POST");
    expect(r.filename).toBe("report.html");
    expect(r.bundle).toBe("compact");
    expect(r.bytes).toBe(42);
  });
  it("exportInteractiveHtml falls back to defaults when headers are absent", async () => {
    vi.stubGlobal("fetch", mockBlob({}));
    const r = await api.exportInteractiveHtml({}, null);
    expect(r.filename).toBe("dashboard.html");
    expect(r.bundle).toBe("standard");
    expect(r.bytes).toBe(0);
  });
  it("exportInteractiveHtml throws on non-ok", async () => {
    vi.stubGlobal("fetch", mockBlob({}, false, 500));
    await expect(api.exportInteractiveHtml({}, null)).rejects.toThrow();
  });
  it("fetchStaticAsset returns the blob for a same-origin path", async () => {
    vi.stubGlobal("fetch", mockBlob({}));
    await expect(api.fetchStaticAsset("/sample.csv")).resolves.toBeDefined();
    expect(lastCall.url).toBe("/sample.csv");
  });
  it("fetchStaticAsset throws on non-ok", async () => {
    vi.stubGlobal("fetch", mockBlob({}, false, 404));
    await expect(api.fetchStaticAsset("/missing")).rejects.toThrow(/missing/);
  });
});

describe("write wrappers reject on non-ok (optimistic-mirror revert paths)", () => {
  it.each([
    ["setActiveModels", () => api.setActiveModels({ codeGen: "m" })],
    [
      "putLocalLlmConfig",
      () => api.putLocalLlmConfig({ backend: "o", enabled: true, activeModel: "m" }),
    ],
    ["deleteSavedConnection", () => api.deleteSavedConnection("id")],
    ["renameSavedConnection", () => api.renameSavedConnection("id", "n")],
    ["deleteLocalLlmModel", () => api.deleteLocalLlmModel({ backend: "o", model: "m" })],
    ["unbindDbtManifest", () => api.unbindDbtManifest("wh1")],
  ] as const)("%s rejects on 500", async (_n, call) => {
    vi.stubGlobal("fetch", mockOk({ error: "bad" }, false, 500));
    await expect(call()).rejects.toThrow();
  });
});

describe("downloadLocalLlmModel returns the raw streaming Response", () => {
  it("resolves to the Response on ok", async () => {
    vi.stubGlobal("fetch", mockOk({}));
    const res = await api.downloadLocalLlmModel({ backend: "ollama", model: "m" });
    expect(res).toBeDefined();
    expect(lastCall.url).toBe("/api/local-llm/download");
    expect(String(lastCall.init?.method)).toBe("POST");
  });
  it("throws when the server rejects the download", async () => {
    vi.stubGlobal("fetch", mockOk({}, false, 500));
    await expect(api.downloadLocalLlmModel({ backend: "ollama", model: "m" })).rejects.toThrow();
  });
});

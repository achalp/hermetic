import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/local-llm/config — multi-backend config surface. GET without a
 * ?backend returns all three blocks; with one returns that block; an unknown
 * backend 400s. PUT persists a backend's config (stopping a disabled server),
 * unknown backend 400s, malformed body 400s.
 */
const { state, setRuntimeConfig, stopServer } = vi.hoisted(() => {
  const state = { rc: {} as Record<string, unknown> };
  return {
    state,
    setRuntimeConfig: vi.fn((patch: Record<string, unknown>) => {
      state.rc = { ...state.rc, ...patch };
      return state.rc;
    }),
    stopServer: vi.fn(),
  };
});
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => state.rc,
  setRuntimeConfig,
  clearRuntimeConfigCache: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ clearEnvConfigCache: vi.fn() }));
vi.mock("@/lib/llm/process-manager", () => ({ stopServer: (...a: unknown[]) => stopServer(...a) }));
vi.mock("@/lib/constants", () => ({
  DEFAULT_LOCAL_LLM_ENDPOINTS: {
    ollama: "http://localhost:11434",
    mlx: "http://localhost:8080",
    "llama-cpp": "http://localhost:8081",
  },
}));

import { GET, PUT } from "@/app/api/local-llm/config/route";

const get = (qs = "") => GET(new Request(`http://x/api/local-llm/config${qs}`));
const put = (b: unknown) =>
  PUT(new Request("http://x/api/local-llm/config", { method: "PUT", body: JSON.stringify(b) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.rc = {};
  stopServer.mockResolvedValue(undefined);
});

describe("GET /api/local-llm/config", () => {
  it("returns all backend blocks when no backend is given", async () => {
    const body = await (await get()).json();
    expect(body.ollama).toBeDefined();
    expect(body.mlx).toBeDefined();
    expect(body.llamaCpp).toBeDefined();
  });

  it("returns a single backend block", async () => {
    const body = await (await get("?backend=mlx")).json();
    expect(body.config.baseUrl).toBe("http://localhost:8080");
  });

  it("400s on an unknown backend", async () => {
    const res = await get("?backend=nope");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/local-llm/config", () => {
  it("persists the mlx config", async () => {
    const res = await put({
      backend: "mlx",
      enabled: true,
      baseUrl: "http://h:9",
      activeModel: "m",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config).toEqual({ enabled: true, baseUrl: "http://h:9", activeModel: "m" });
  });

  it("stops the server when a non-ollama backend is disabled", async () => {
    await put({ backend: "llama-cpp", enabled: false });
    expect(stopServer).toHaveBeenCalledWith("llama-cpp");
  });

  it("400s on an unknown backend", async () => {
    const res = await put({ backend: "nope", enabled: true });
    expect(res.status).toBe(400);
  });

  it("400s on a malformed body", async () => {
    const res = await PUT(new Request("http://x", { method: "PUT", body: "{" }));
    expect(res.status).toBe(400);
  });
});

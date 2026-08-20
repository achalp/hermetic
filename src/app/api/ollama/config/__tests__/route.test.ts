import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/ollama/config — GET returns the stored ollama block (or defaults);
 * PUT writes it through runtime-config and clears the config caches. A
 * malformed PUT body 400s.
 */
const { state, setRuntimeConfig, clearRuntimeConfigCache, clearEnvConfigCache } = vi.hoisted(() => {
  const state = { rc: {} as Record<string, unknown> };
  return {
    state,
    setRuntimeConfig: vi.fn((patch: Record<string, unknown>) => {
      state.rc = { ...state.rc, ...patch };
      return state.rc;
    }),
    clearRuntimeConfigCache: vi.fn(),
    clearEnvConfigCache: vi.fn(),
  };
});
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => state.rc,
  setRuntimeConfig,
  clearRuntimeConfigCache,
}));
vi.mock("@/lib/config", () => ({ clearEnvConfigCache }));
vi.mock("@/lib/constants", () => ({
  DEFAULT_LOCAL_LLM_ENDPOINTS: {
    ollama: "http://localhost:11434",
    mlx: "http://localhost:8080",
    "llama-cpp": "http://localhost:8081",
  },
}));

import { GET, PUT } from "@/app/api/ollama/config/route";

beforeEach(() => {
  vi.clearAllMocks();
  state.rc = {};
});

describe("GET /api/ollama/config", () => {
  it("returns defaults when nothing is stored", async () => {
    const body = await (await GET()).json();
    expect(body.ollama).toEqual({
      enabled: false,
      baseUrl: "http://localhost:11434",
      activeModel: "",
    });
  });

  it("returns the stored ollama block", async () => {
    state.rc = { ollama: { enabled: true, baseUrl: "http://host:1", activeModel: "llama3" } };
    const body = await (await GET()).json();
    expect(body.ollama.activeModel).toBe("llama3");
  });
});

describe("PUT /api/ollama/config", () => {
  it("persists the config and clears caches", async () => {
    const req = new Request("http://x", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, baseUrl: "http://h:2", activeModel: "qwen" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ollama).toEqual({ enabled: true, baseUrl: "http://h:2", activeModel: "qwen" });
    expect(clearRuntimeConfigCache).toHaveBeenCalled();
    expect(clearEnvConfigCache).toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    const res = await PUT(new Request("http://x", { method: "PUT", body: "{" }));
    expect(res.status).toBe(400);
  });
});

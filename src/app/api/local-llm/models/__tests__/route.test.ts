import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/local-llm/models — per-backend model listing. The ollama branch
 * lists via /api/tags (fetch mocked); an unknown backend returns an empty
 * list. fs/child_process are mocked so the cache-scan branches never touch
 * the real disk.
 */
const state = vi.hoisted(() => ({ rc: {} as Record<string, unknown> }));
vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig: () => state.rc }));
vi.mock("@/lib/constants", () => ({
  DEFAULT_LOCAL_LLM_ENDPOINTS: { ollama: "http://localhost:11434" },
}));
vi.mock("fs", () => ({ readdirSync: () => [], statSync: () => ({}), mkdirSync: () => undefined }));
vi.mock("child_process", () => ({
  execSync: () => {
    throw new Error("no hf");
  },
}));
vi.mock("@/lib/paths", () => ({ hermeticPaths: { ggufModelsDir: () => "/models/gguf" } }));

import { GET } from "@/app/api/local-llm/models/route";

const get = (qs = "") => GET(new Request(`http://x/api/local-llm/models${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  state.rc = { ollama: { baseUrl: "http://ol:11434" } };
});

describe("GET /api/local-llm/models", () => {
  it("lists ollama models via /api/tags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "llama3", size: 1, modified_at: "t" }] }),
      })
    );
    const res = await get("?backend=ollama");
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([{ name: "llama3", size: 1, modified_at: "t" }]);
  });

  it("502s when ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await get("?backend=ollama");
    expect(res.status).toBe(502);
  });

  it("returns an empty list for an unknown backend", async () => {
    const res = await get("?backend=weird");
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([]);
  });

  it("merges the mlx server's loaded models with the cache scan", async () => {
    state.rc = { mlx: { baseUrl: "http://mlx:8080" } };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ id: "mlx-community/Qwen" }] }),
      })
    );
    const res = await get("?backend=mlx");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.models.map((m: { name: string }) => m.name)).toContain("mlx-community/Qwen");
  });

  it("falls back to the mlx cache scan when the server is unreachable", async () => {
    state.rc = { mlx: { baseUrl: "http://mlx:8080" } };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await get("?backend=mlx");
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([]); // fs scan mocked empty
  });

  it("lists llama-cpp GGUF models and marks the active one when the server is healthy", async () => {
    state.rc = { llamaCpp: { baseUrl: "http://lc:8081", activeModel: "phi.gguf" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const res = await get("?backend=llama-cpp");
    expect(res.status).toBe(200);
    const body = await res.json();
    // The active model is injected at the front when not already in the (empty) cache.
    expect(body.models[0].name).toBe("phi.gguf");
  });
});

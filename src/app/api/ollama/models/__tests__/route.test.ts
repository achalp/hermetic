import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/ollama/models — GET lists via ollama /api/tags (fetch mocked);
 * DELETE removes a model by name (400 without a name, 502 on transport
 * failure).
 */
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => ({ ollama: { baseUrl: "http://ol:11434" } }),
}));
vi.mock("@/lib/constants", () => ({
  DEFAULT_LOCAL_LLM_ENDPOINTS: { ollama: "http://localhost:11434" },
}));

import { GET, DELETE } from "@/app/api/ollama/models/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/ollama/models", () => {
  it("maps the tags response into a model list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ models: [{ name: "llama3", size: 42, modified_at: "t" }] }),
      })
    );
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).models).toEqual([{ name: "llama3", size: 42, modified_at: "t" }]);
  });

  it("502s when ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await GET();
    expect(res.status).toBe(502);
  });

  it("502s on a non-ok tags response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const res = await GET();
    expect(res.status).toBe(502);
  });
});

describe("DELETE /api/ollama/models", () => {
  const del = (b: unknown) =>
    DELETE(new Request("http://x", { method: "DELETE", body: JSON.stringify(b) }));

  it("400s without a name", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await del({});
    expect(res.status).toBe(400);
  });

  it("deletes the named model", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const res = await del({ name: "llama3" });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it("502s when the delete call fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const res = await del({ name: "llama3" });
    expect(res.status).toBe(502);
  });
});

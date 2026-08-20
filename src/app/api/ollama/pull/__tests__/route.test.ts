import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/ollama/pull — proxies a model pull, streaming NDJSON progress
 * back. 400 without a name, 502 when ollama is unreachable / returns non-ok /
 * has no body, and a streamed passthrough on success.
 */
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => ({ ollama: { baseUrl: "http://ol:11434" } }),
}));
vi.mock("@/lib/constants", () => ({
  DEFAULT_LOCAL_LLM_ENDPOINTS: { ollama: "http://localhost:11434" },
}));

import { POST } from "@/app/api/ollama/pull/route";

const req = (b: unknown) =>
  new Request("http://x/api/ollama/pull", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/ollama/pull", () => {
  it("400s without a name", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect((await POST(req({}))).status).toBe(400);
  });

  it("502s when the pull call is non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect((await POST(req({ name: "llama3" }))).status).toBe(502);
  });

  it("502s when the pull response has no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: null }));
    expect((await POST(req({ name: "llama3" }))).status).toBe(502);
  });

  it("streams NDJSON progress on success", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"status":"pulling"}\n'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: upstream }));
    const res = await POST(req({ name: "llama3" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    expect(await res.text()).toContain("pulling");
  });

  it("502s when ollama is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect((await POST(req({ name: "llama3" }))).status).toBe(502);
  });
});

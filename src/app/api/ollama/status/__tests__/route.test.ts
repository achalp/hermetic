import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/ollama/status — probes the ollama /api/version endpoint (fetch
 * mocked). Healthy → running:true + version; unreachable/non-ok → running:false.
 */
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => ({ ollama: { baseUrl: "http://ol:11434" } }),
}));
vi.mock("@/lib/constants", () => ({
  DEFAULT_LOCAL_LLM_ENDPOINTS: { ollama: "http://localhost:11434" },
}));

import { GET } from "@/app/api/ollama/status/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/ollama/status", () => {
  it("reports running with a version when the server answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "0.3.1" }) })
    );
    const body = await (await GET()).json();
    expect(body).toEqual({ running: true, version: "0.3.1", baseUrl: "http://ol:11434" });
  });

  it("reports not running on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const body = await (await GET()).json();
    expect(body).toEqual({ running: false, baseUrl: "http://ol:11434" });
  });

  it("reports not running when the fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const body = await (await GET()).json();
    expect(body.running).toBe(false);
  });
});

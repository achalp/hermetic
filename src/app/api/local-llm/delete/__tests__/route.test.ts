import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "path";

/**
 * Contract tests for POST /api/local-llm/delete — the route rm -rf's model
 * directories, so what matters is that the path it deletes is confined to the
 * model stores. fs.rmSync is mocked (nothing is actually deleted) and Ollama's
 * HTTP API is stubbed via global fetch.
 */

const rmSync = vi.fn();
vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  rmSync: (...args: unknown[]) => rmSync(...args),
}));

vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig: () => ({}) }));

vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/local-llm/delete/route";
import { hermeticPaths } from "@/lib/paths";

const makeRequest = (body: unknown) =>
  new Request("http://localhost/api/local-llm/delete", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/local-llm/delete", () => {
  it("rejects a missing model", async () => {
    const res = await POST(makeRequest({ backend: "mlx" }));
    expect(res.status).toBe(400);
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("rejects an unknown backend", async () => {
    const res = await POST(makeRequest({ backend: "rogue", model: "m" }));
    expect(res.status).toBe(400);
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("llama-cpp: rejects a ..-traversal out of the GGUF dir without deleting", async () => {
    const res = await POST(makeRequest({ backend: "llama-cpp", model: "../../../etc/anything" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid model path");
    expect(rmSync).not.toHaveBeenCalled();
  });

  it("llama-cpp: deletes a model confined to the GGUF dir", async () => {
    const res = await POST(makeRequest({ backend: "llama-cpp", model: "model-Q4_K_M.gguf" }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(rmSync).toHaveBeenCalledWith(
      join(hermeticPaths.ggufModelsDir(), "model-Q4_K_M.gguf"),
      expect.objectContaining({ recursive: true })
    );
  });

  it("mlx: deletes only inside the HuggingFace cache (slashes become -- segments)", async () => {
    const res = await POST(makeRequest({ backend: "mlx", model: "mlx-community/Qwen2.5-4bit" }));
    expect(res.status).toBe(200);
    const deleted = rmSync.mock.calls[0][0] as string;
    expect(deleted).toContain(join("huggingface", "hub", "models--mlx-community--Qwen2.5-4bit"));
  });

  it("ollama: maps an unreachable daemon to a 502 without leaking the raw failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434 (stack trace here)");
      })
    );
    const res = await POST(makeRequest({ backend: "ollama", model: "llama3" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Cannot reach Ollama");
    vi.unstubAllGlobals();
  });
});

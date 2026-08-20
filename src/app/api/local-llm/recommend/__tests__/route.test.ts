import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/local-llm/recommend — wraps the `llmfit` CLI (execSync mocked).
 * When llmfit is missing, the route degrades to a fallback empty list; when
 * present, it parses the JSON and filters to backend-compatible models.
 */
const execSync = vi.fn();
vi.mock("child_process", () => ({ execSync: (...a: unknown[]) => execSync(...a) }));

import { GET } from "@/app/api/local-llm/recommend/route";

const get = (qs = "") => GET(new Request(`http://x/api/local-llm/recommend${qs}`));

beforeEach(() => vi.clearAllMocks());

describe("GET /api/local-llm/recommend", () => {
  it("returns the fallback list when llmfit is not installed", async () => {
    execSync.mockImplementation(() => {
      throw new Error("which: no llmfit");
    });
    const res = await get("?backend=mlx&limit=3");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("fallback");
    expect(body.models).toEqual([]);
  });

  it("parses and filters llmfit output for the mlx backend", async () => {
    execSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which llmfit")) return ""; // available
      return JSON.stringify({
        models: [
          { name: "mlx-community/Qwen-4bit", best_quant: "mlx-4", gguf_sources: [] },
          { name: "meta/pytorch-model", best_quant: "fp16", gguf_sources: [] },
        ],
      });
    });
    const res = await get("?backend=mlx&limit=5");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toBe("llmfit");
    // Only the mlx-community model survives the compatibility filter.
    expect(body.models.map((m: { name: string }) => m.name)).toEqual(["mlx-community/Qwen-4bit"]);
  });

  it("degrades to fallback when the llmfit command fails", async () => {
    execSync.mockImplementation((cmd: string) => {
      if (cmd.includes("which llmfit")) return "";
      throw new Error("llmfit crashed");
    });
    const body = await (await get("?backend=llama-cpp")).json();
    expect(body.source).toBe("fallback");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Contract tests for POST /api/local-llm/download. The route spawns real
 * download processes, so child_process is mocked wholesale: execSync throws
 * (no huggingface CLI on the "machine") and spawn is a spy that must never be
 * reached by an invalid request. Network calls (HF compatibility probe,
 * Ollama pull) go through a stubbed global fetch. The streaming-progress
 * plumbing itself is not re-tested here — only the route's validation and
 * error mapping.
 */

const spawn = vi.fn();
const execSync = vi.fn((): never => {
  throw new Error("not found");
});
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: (...args: unknown[]) => spawn(...args),
  execSync: () => execSync(),
}));

vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig: () => ({}) }));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/local-llm/download/route";

const makeRequest = (body: unknown) =>
  new Request("http://localhost/api/local-llm/download", {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Parse an ndjson response body into its event objects. */
async function ndjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /api/local-llm/download", () => {
  it("rejects a missing model", async () => {
    const res = await POST(makeRequest({ backend: "mlx" }));
    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an unknown backend", async () => {
    const res = await POST(makeRequest({ backend: "rogue", model: "m" }));
    expect(res.status).toBe(400);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("ollama: maps a failed pull to a 502 { error } body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream detail", { status: 500 }))
    );
    const res = await POST(makeRequest({ backend: "ollama", model: "llama3" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("Failed to pull model");
  });

  it("mlx: refuses a repo without safetensors weights before spawning anything", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ siblings: [{ rfilename: "pytorch_model.bin" }] }), {
            status: 200,
          })
      )
    );
    const res = await POST(makeRequest({ backend: "mlx", model: "some/torch-only-model" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not compatible with MLX");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("mlx: reports missing huggingface-hub as an in-stream error, not a crash", async () => {
    // Compatibility probe can't verify (non-ok) → download proceeds; with no
    // downloader available the stream must end with an actionable error event.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );
    const res = await POST(makeRequest({ backend: "mlx", model: "mlx-community/ok-model" }));
    expect(res.status).toBe(200);
    const events = await ndjson(res);
    const last = events[events.length - 1];
    expect(last.error).toBe(true);
    expect(String(last.status)).toContain("huggingface-hub is not installed");
    expect(spawn).not.toHaveBeenCalled();
  });
});

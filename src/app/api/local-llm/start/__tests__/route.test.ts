import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for POST /api/local-llm/start — the route that spawns a host
 * process. process-manager is mocked at the module boundary: what's under test
 * is the route's input validation (nothing reaches the spawner on bad input)
 * and its error mapping (a spawn failure becomes a bounded { error } body, not
 * a raw throw). Process lifecycle itself is covered by the process-manager
 * lib tests.
 */

const startServer = vi.fn();
vi.mock("@/lib/llm/process-manager", () => ({
  startServer: (...args: unknown[]) => startServer(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/local-llm/start/route";
import { MAX_CLIENT_ERROR_CHARS } from "@/app/lib/api-error";

const makeRequest = (body: unknown) =>
  new Request("http://localhost/api/local-llm/start", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  startServer.mockResolvedValue({ port: 8080, pid: 1234 });
});

describe("POST /api/local-llm/start", () => {
  it("rejects a missing backend or model without touching the spawner", async () => {
    for (const body of [{}, { backend: "mlx" }, { model: "some-model" }]) {
      const res = await POST(makeRequest(body));
      expect(res.status).toBe(400);
    }
    expect(startServer).not.toHaveBeenCalled();
  });

  it("rejects an unknown backend", async () => {
    const res = await POST(makeRequest({ backend: "rogue-backend", model: "m" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("backend must be");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("starts a valid backend and reports status=starting (client must poll)", async () => {
    const res = await POST(
      makeRequest({ backend: "llama-cpp", model: "m.gguf", port: 9090, contextLength: 4096 })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, status: "starting", port: 8080, pid: 1234 });
    expect(startServer).toHaveBeenCalledWith(
      "llama-cpp",
      expect.objectContaining({ model: "m.gguf", port: 9090, contextLength: 4096 })
    );
  });

  it("maps a spawn failure to a 500 { error } body, capped — no raw error object", async () => {
    startServer.mockRejectedValue(
      new Error("spawn failed: " + "x".repeat(MAX_CLIENT_ERROR_CHARS * 2))
    );
    const res = await POST(makeRequest({ backend: "mlx", model: "m" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toContain("spawn failed");
    expect(body.error.length).toBeLessThanOrEqual(MAX_CLIENT_ERROR_CHARS);
  });
});

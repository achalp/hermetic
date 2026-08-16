import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for POST /api/local-llm/stop. Same scope as the start route's
 * tests: validation gates the process-manager call, and a kill failure maps to
 * a bounded { error } body instead of leaking a throw.
 */

const stopServer = vi.fn();
vi.mock("@/lib/llm/process-manager", () => ({
  stopServer: (...args: unknown[]) => stopServer(...args),
}));

vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/local-llm/stop/route";

const makeRequest = (body: unknown) =>
  new Request("http://localhost/api/local-llm/stop", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  stopServer.mockResolvedValue(undefined);
});

describe("POST /api/local-llm/stop", () => {
  it("rejects a missing backend without touching the process manager", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(stopServer).not.toHaveBeenCalled();
  });

  it("stops the named backend", async () => {
    const res = await POST(makeRequest({ backend: "mlx" }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(stopServer).toHaveBeenCalledWith("mlx");
  });

  it("maps a stop failure to a 500 { error } body", async () => {
    stopServer.mockRejectedValue(new Error("kill ESRCH"));
    const res = await POST(makeRequest({ backend: "mlx" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toContain("kill ESRCH");
  });
});

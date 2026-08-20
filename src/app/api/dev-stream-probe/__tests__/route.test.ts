import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * GET /api/dev-stream-probe — dev-only transport probe. In production it 404s;
 * in dev it streams a text/plain keepalive whose first chunk is the "probe
 * start" line. Fake timers keep the 15s tick interval from firing for real.
 */
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/dev-stream-probe/route";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/dev-stream-probe", () => {
  it("404s in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await GET(new Request("http://x/api/dev-stream-probe"));
    expect(res.status).toBe(404);
  });

  it("streams the probe-start line with keepalive headers in dev", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const req = new Request("http://x/api/dev-stream-probe");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("probe start");
    await reader.cancel();
  });
});

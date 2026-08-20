import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/client-log — the client→server log bridge. A valid record is
 * forwarded to the matching logger level and answered 204; a malformed or
 * aborted body must never produce error noise — it also 204s silently.
 */
const { logger } = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({ logger }));

import { POST } from "@/app/api/client-log/route";

const req = (body: unknown) =>
  new Request("http://x/api/client-log", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/client-log", () => {
  it("forwards a valid record to the matching logger level with runId meta", async () => {
    const res = await POST(
      req({ level: "warn", msg: "unmounted while streaming", runId: "run-9", meta: { k: 1 } })
    );
    expect(res.status).toBe(204);
    expect(logger.warn).toHaveBeenCalledWith("[client] unmounted while streaming", {
      runId: "run-9",
      k: 1,
    });
  });

  it("logs without runId meta when none is provided", async () => {
    await POST(req({ level: "info", msg: "hello" }));
    expect(logger.info).toHaveBeenCalledWith("[client] hello", undefined);
  });

  it("400s on an invalid level without logging", async () => {
    const res = await POST(req({ level: "trace", msg: "x" }));
    expect(res.status).toBe(400);
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("204s on a non-JSON body without throwing", async () => {
    const res = await POST(
      new Request("http://x/api/client-log", { method: "POST", body: "not json" })
    );
    expect(res.status).toBe(204);
  });
});

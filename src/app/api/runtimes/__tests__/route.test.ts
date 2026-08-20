import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/runtimes — GET probes docker (daemon + image via execFile),
 * microsandbox (fetch), and e2b (env). PATCH persists the sandbox runtime
 * selection, rejecting anything outside the known set.
 */
const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...a: unknown[]) => execFile(...a) }));
const setRuntimeConfig = vi.fn();
vi.mock("@/lib/runtime-config", () => ({
  setRuntimeConfig: (...a: unknown[]) => setRuntimeConfig(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/constants", () => ({ DOCKER_SANDBOX_IMAGE: "hermetic-sandbox:test" }));

import { GET, PATCH } from "@/app/api/runtimes/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("E2B_API_KEY", "");
  vi.stubEnv("MICROSANDBOX_URL", "");
  // fetch (microsandbox) fails by default → unavailable
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
});

describe("GET /api/runtimes", () => {
  it("reports docker available when daemon + image both succeed", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
    const res = await GET();
    expect(res.status).toBe(200);
    const runtimes = await res.json();
    const docker = runtimes.find((r: { id: string }) => r.id === "docker");
    expect(docker.available).toBe(true);
  });

  it("reports docker unavailable when the daemon probe fails", async () => {
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("no daemon")));
    const runtimes = await (await GET()).json();
    expect(runtimes.find((r: { id: string }) => r.id === "docker").available).toBe(false);
  });

  it("reports e2b available when its API key is set", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b-xyz");
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("no daemon")));
    const runtimes = await (await GET()).json();
    expect(runtimes.find((r: { id: string }) => r.id === "e2b").available).toBe(true);
  });
});

describe("PATCH /api/runtimes", () => {
  const patch = (body: unknown) =>
    PATCH(new Request("http://x/api/runtimes", { method: "PATCH", body: JSON.stringify(body) }));

  it("persists a valid runtime selection", async () => {
    const res = await patch({ sandboxRuntime: "e2b" });
    expect(res.status).toBe(200);
    expect((await res.json()).sandboxRuntime).toBe("e2b");
    expect(setRuntimeConfig).toHaveBeenCalledWith({ sandboxRuntime: "e2b" });
  });

  it("rejects an unknown runtime", async () => {
    const res = await patch({ sandboxRuntime: "vm-of-doom" });
    expect(res.status).toBe(400);
    expect(setRuntimeConfig).not.toHaveBeenCalled();
  });

  it("400s on a malformed body", async () => {
    const res = await PATCH(new Request("http://x/api/runtimes", { method: "PATCH", body: "{" }));
    expect(res.status).toBe(400);
  });
});

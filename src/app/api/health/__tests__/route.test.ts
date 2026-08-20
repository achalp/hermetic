import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/health — dependency-light liveness probe. Reports version + the
 * configured sandbox runtime; for docker it also runs a bounded `docker info`
 * probe (execFile mocked), for other runtimes it reports config only.
 */
const getActiveSandboxRuntime = vi.fn();
vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: () => getActiveSandboxRuntime(),
}));

const execFile = vi.fn();
vi.mock("node:child_process", () => ({ execFile: (...a: unknown[]) => execFile(...a) }));

import { GET } from "@/app/api/health/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/health", () => {
  it("reports the docker daemon result when docker is the runtime", async () => {
    getActiveSandboxRuntime.mockReturnValue("docker");
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(null)); // daemon responds
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(body.sandbox).toEqual({ runtime: "docker", docker_daemon: true });
  });

  it("reports docker_daemon false when the probe errors", async () => {
    getActiveSandboxRuntime.mockReturnValue("docker");
    execFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error("no daemon")));
    const body = await (await GET()).json();
    expect(body.sandbox.docker_daemon).toBe(false);
  });

  it("omits the docker probe for non-docker runtimes", async () => {
    getActiveSandboxRuntime.mockReturnValue("e2b");
    const body = await (await GET()).json();
    expect(body.sandbox).toEqual({ runtime: "e2b" });
    expect(execFile).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/local-llm/status — synthesizes a backend's status from the process
 * manager (health check, run/starting/grace flags), the stored config, and any
 * active downloads. Covers the ready, starting, and stopped-with-stale-PID
 * cleanup paths.
 */
const state = vi.hoisted(() => ({ rc: {} as Record<string, unknown> }));
const healthCheck = vi.fn();
const isRunning = vi.fn();
const isWithinStartupGrace = vi.fn();
const isStarting = vi.fn();
const getServerLogs = vi.fn();
const setRuntimeConfig = vi.fn();
const getActiveDownloads = vi.fn();
vi.mock("child_process", () => ({
  execSync: () => {
    throw new Error("not darwin");
  },
}));
vi.mock("@/lib/llm/process-manager", () => ({
  healthCheck: (...a: unknown[]) => healthCheck(...a),
  isRunning: (...a: unknown[]) => isRunning(...a),
  isWithinStartupGrace: (...a: unknown[]) => isWithinStartupGrace(...a),
  isStarting: (...a: unknown[]) => isStarting(...a),
  getServerLogs: (...a: unknown[]) => getServerLogs(...a),
}));
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => state.rc,
  setRuntimeConfig: (...a: unknown[]) => setRuntimeConfig(...a),
}));
vi.mock("@/app/api/local-llm/download/route", () => ({
  getActiveDownloads: (...a: unknown[]) => getActiveDownloads(...a),
}));

import { GET } from "@/app/api/local-llm/status/route";

const get = (qs = "") => GET(new Request(`http://x/api/local-llm/status${qs}`));

beforeEach(() => {
  vi.clearAllMocks();
  state.rc = { mlx: { baseUrl: "http://localhost:8080", activeModel: "qwen" } };
  isRunning.mockReturnValue(false);
  isWithinStartupGrace.mockReturnValue(false);
  isStarting.mockReturnValue(false);
  getServerLogs.mockReturnValue([]);
  getActiveDownloads.mockReturnValue([]);
});

describe("GET /api/local-llm/status", () => {
  it("reports ready when the health check passes", async () => {
    healthCheck.mockResolvedValue(true);
    const res = await get("?backend=mlx");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.running).toBe(true);
    expect(body.activeModel).toBe("qwen");
  });

  it("reports starting when the process is alive but not yet healthy", async () => {
    healthCheck.mockResolvedValue(false);
    isRunning.mockReturnValue(true);
    const body = await (await get("?backend=mlx")).json();
    expect(body.status).toBe("starting");
  });

  it("reports stopped and clears a stale PID when nothing is alive", async () => {
    state.rc = { mlx: { baseUrl: "http://localhost:8080", activeModel: "qwen", pid: 4242 } };
    healthCheck.mockResolvedValue(false);
    // process.kill(pid, 0) throws → pid not alive
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const body = await (await get("?backend=mlx")).json();
    expect(body.status).toBe("stopped");
    expect(setRuntimeConfig).toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

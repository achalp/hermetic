import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing process-manager
const mockSpawn = vi.fn();
const mockExecSync = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock runtime-config
const mockConfig: Record<string, unknown> = {};
const mockSetRuntimeConfig = vi.fn((partial: Record<string, unknown>) => {
  Object.assign(mockConfig, partial);
  return mockConfig;
});
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => mockConfig,
  setRuntimeConfig: (partial: Record<string, unknown>) => mockSetRuntimeConfig(partial),
}));

// Mock logger
vi.mock("@/lib/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Clean up globalThis state between tests
function cleanGlobalState() {
  const g = globalThis as Record<string, unknown>;
  delete g.__llmProcesses;
  delete g.__llmServerLogs;
  delete g.__llmStartLocks;
  delete g.__llmStartTimestamps;
}

describe("process-manager", () => {
  beforeEach(() => {
    cleanGlobalState();
    vi.resetModules();
    mockSpawn.mockReset();
    mockExecSync.mockReset();
    mockSetRuntimeConfig.mockClear();
    Object.keys(mockConfig).forEach((k) => delete mockConfig[k]);
  });

  describe("healthCheck", () => {
    it("returns true when server responds OK", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

      expect(await healthCheck("mlx")).toBe(true);
    });

    it("returns false when server is unreachable", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

      expect(await healthCheck("mlx")).toBe(false);
    });

    it("returns false for unknown backend", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      expect(await healthCheck("unknown")).toBe(false);
    });

    it("uses correct health URL for each backend", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", mockFetch);

      await healthCheck("ollama");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/version"),
        expect.any(Object)
      );

      mockFetch.mockClear();
      await healthCheck("mlx");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/models"),
        expect.any(Object)
      );

      mockFetch.mockClear();
      // llama-cpp uses /health endpoint
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ status: "ok" }) });
      await healthCheck("llama-cpp");
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/health"),
        expect.any(Object)
      );
    });
  });

  describe("isRunning", () => {
    it("returns false when no process tracked and no PID in config", async () => {
      const { isRunning } = await import("../llm/process-manager");
      expect(isRunning("mlx")).toBe(false);
    });

    it("returns true when config has a live PID", async () => {
      // Use our own PID — guaranteed alive
      Object.assign(mockConfig, { mlx: { pid: process.pid } });
      const { isRunning } = await import("../llm/process-manager");
      expect(isRunning("mlx")).toBe(true);
    });

    it("returns false when config has a dead PID", async () => {
      Object.assign(mockConfig, { mlx: { pid: 999999 } });
      const { isRunning } = await import("../llm/process-manager");
      expect(isRunning("mlx")).toBe(false);
    });
  });

  describe("isWithinStartupGrace", () => {
    it("returns false when no startup timestamp exists", async () => {
      const { isWithinStartupGrace } = await import("../llm/process-manager");
      expect(isWithinStartupGrace("mlx")).toBe(false);
    });
  });

  describe("startServer", () => {
    function makeMockProc(pid: number | undefined = 12345) {
      return {
        pid,
        exitCode: null,
        killed: false,
        unref: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };
    }

    function setupMlxExecSync() {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which mlx_lm.server"))
          return "/usr/local/bin/mlx_lm.server";
        if (typeof cmd === "string" && cmd.includes("lsof")) throw new Error("not found");
        if (typeof cmd === "string" && cmd.includes("sysctl")) return "34359738368"; // 32GB
        return "";
      });
    }

    it("throws when port is already in use", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("lsof -ti :8080")) return "99999";
        throw new Error("not found");
      });

      const { startServer } = await import("../llm/process-manager");
      await expect(startServer("mlx", { model: "test-model" })).rejects.toThrow(
        /Port 8080 is already in use/
      );
    });

    it("throws when spawn returns no PID (binary not found)", async () => {
      // Create a proc with no PID — simulates "command not found"
      const noPidProc = {
        pid: undefined,
        exitCode: null,
        killed: false,
        unref: vi.fn(),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValueOnce(noPidProc);
      setupMlxExecSync();

      const { startServer } = await import("../llm/process-manager");
      await expect(startServer("mlx", { model: "test-model" })).rejects.toThrow(/Failed to spawn/);
    });

    it("binds MLX to 127.0.0.1 for security", async () => {
      mockSpawn.mockReturnValue(makeMockProc());
      setupMlxExecSync();

      const { startServer } = await import("../llm/process-manager");
      const result = await startServer("mlx", { model: "test-model" });

      // Verify spawn args contain 127.0.0.1 (not 0.0.0.0)
      const spawnCall = mockSpawn.mock.calls.find(
        (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("--host")
      );
      expect(spawnCall).toBeDefined();
      const args = spawnCall![1] as string[];
      const hostIdx = args.indexOf("--host");
      expect(args[hostIdx + 1]).toBe("127.0.0.1");
      expect(result.baseUrl).toContain("127.0.0.1");
    });

    it("sets MLX_METAL_CACHE_LIMIT env var based on system RAM", async () => {
      mockSpawn.mockReturnValue(makeMockProc());
      setupMlxExecSync();

      const { startServer } = await import("../llm/process-manager");
      await startServer("mlx", { model: "test-model" });

      // Verify spawn was called with env containing MLX_METAL_CACHE_LIMIT
      const spawnCall = mockSpawn.mock.calls.find(
        (c: unknown[]) =>
          c[2] && typeof c[2] === "object" && "env" in (c[2] as Record<string, unknown>)
      );
      expect(spawnCall).toBeDefined();
      const env = (spawnCall![2] as { env: Record<string, string> }).env;
      expect(env.MLX_METAL_CACHE_LIMIT).toBeDefined();
      // 90% of 32GB ≈ 28.8GB in bytes
      const limitBytes = parseInt(env.MLX_METAL_CACHE_LIMIT, 10);
      expect(limitBytes).toBeGreaterThan(20 * 1024 ** 3);
      expect(limitBytes).toBeLessThan(33 * 1024 ** 3);
    });

    it("detects early process crash and throws", async () => {
      const mockProc = makeMockProc();
      mockSpawn.mockReturnValue(mockProc);
      setupMlxExecSync();

      // Simulate process crashing immediately after spawn
      mockProc.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "exit") {
          // Call exit handler synchronously to simulate instant crash
          setTimeout(() => handler(1, null), 50);
        }
      });

      const { startServer } = await import("../llm/process-manager");
      await expect(startServer("mlx", { model: "test-model" })).rejects.toThrow(/failed to start/);
    });

    it("detects SIGABRT (OOM) crash and provides helpful message", async () => {
      const mockProc = makeMockProc();
      mockSpawn.mockReturnValue(mockProc);
      setupMlxExecSync();

      mockProc.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (event === "exit") {
          setTimeout(() => handler(null, "SIGABRT"), 50);
        }
      });

      const { startServer } = await import("../llm/process-manager");
      await expect(startServer("mlx", { model: "test-model" })).rejects.toThrow(/out of memory/i);
    });

    it("saves PID and config on successful start", async () => {
      mockSpawn.mockReturnValue(makeMockProc(54321));
      setupMlxExecSync();

      const { startServer } = await import("../llm/process-manager");
      const result = await startServer("mlx", { model: "mlx-community/test-4bit" });

      expect(result.pid).toBe(54321);
      expect(mockSetRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mlx: expect.objectContaining({
            enabled: true,
            activeModel: "mlx-community/test-4bit",
            pid: 54321,
          }),
        })
      );
    });

    it("prevents concurrent starts of the same backend", async () => {
      mockSpawn.mockReturnValue(makeMockProc());
      setupMlxExecSync();

      const { startServer, isStarting } = await import("../llm/process-manager");

      // Start first — it will take 2s (early exit timeout)
      const first = startServer("mlx", { model: "test-model" });

      // Give it a tick to acquire the lock
      await new Promise((r) => setTimeout(r, 10));
      expect(isStarting("mlx")).toBe(true);

      // Second call should return immediately without spawning a new process
      const spawnCountBefore = mockSpawn.mock.calls.length;
      await startServer("mlx", { model: "test-model" });
      // No additional spawn call
      expect(mockSpawn.mock.calls.length).toBe(spawnCountBefore);

      // Wait for first to finish
      await first;
      expect(isStarting("mlx")).toBe(false);
    });
  });

  describe("stopServer", () => {
    it("clears config and PID after stopping", async () => {
      Object.assign(mockConfig, {
        mlx: { enabled: true, baseUrl: "http://127.0.0.1:8080", activeModel: "test", pid: 999999 },
      });
      mockExecSync.mockImplementation(() => {
        throw new Error("not found");
      });

      const { stopServer } = await import("../llm/process-manager");
      await stopServer("mlx");

      expect(mockSetRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          mlx: expect.objectContaining({ enabled: false, pid: undefined }),
        })
      );
    });

    it("kills orphan process by port as last resort", async () => {
      // No tracked process, no PID in config
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("lsof -ti :8080")) return "44444\n";
        throw new Error("not found");
      });

      // Mock process.kill
      const originalKill = process.kill;
      const killMock = vi.fn();
      process.kill = killMock as unknown as typeof process.kill;

      try {
        const { stopServer } = await import("../llm/process-manager");
        await stopServer("mlx");

        // Should have tried to kill the orphan
        expect(killMock).toHaveBeenCalledWith(44444, "SIGTERM");
      } finally {
        process.kill = originalKill;
      }
    });
  });

  describe("getServerLogs", () => {
    it("returns empty array for unknown backend", async () => {
      const { getServerLogs } = await import("../llm/process-manager");
      expect(getServerLogs("nonexistent")).toEqual([]);
    });
  });

  describe("resolveGgufModelPath", () => {
    it("returns absolute paths as-is", async () => {
      const { resolveGgufModelPath } = await import("../llm/process-manager");
      expect(resolveGgufModelPath("/absolute/path/model.gguf")).toBe("/absolute/path/model.gguf");
    });

    it("resolves bare .gguf filename to GGUF_DIR", async () => {
      const { resolveGgufModelPath } = await import("../llm/process-manager");
      const result = resolveGgufModelPath("model-Q4_K_M.gguf");
      // Should resolve relative to data/models/gguf
      expect(result).toContain("data/models/gguf");
      expect(result).toContain("model-Q4_K_M.gguf");
    });

    it("handles HF repo ID format", async () => {
      const { resolveGgufModelPath } = await import("../llm/process-manager");
      const result = resolveGgufModelPath("bartowski/Llama-3.2-3B-Instruct-GGUF");
      // Should resolve to something under data/models/gguf
      expect(result).toContain("data/models/gguf");
    });
  });

  describe("healthCheck for llama-cpp", () => {
    it("uses /health endpoint for llama-cpp", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ status: "ok" }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await healthCheck("llama-cpp");
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/health"),
        expect.any(Object)
      );
    });

    it("returns false when llama-cpp is loading model", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "loading model" }),
        })
      );

      expect(await healthCheck("llama-cpp")).toBe(false);
    });

    it("returns true when llama-cpp status is ok", async () => {
      const { healthCheck } = await import("../llm/process-manager");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ status: "ok" }),
        })
      );

      expect(await healthCheck("llama-cpp")).toBe(true);
    });
  });

  describe("startServer llama-cpp", () => {
    it("validates GGUF file exists before spawning", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("which llama-server"))
          return "/usr/local/bin/llama-server";
        if (typeof cmd === "string" && cmd.includes("lsof")) throw new Error("not found");
        return "";
      });

      const { startServer } = await import("../llm/process-manager");
      // Non-existent model path should throw
      await expect(
        startServer("llama-cpp", { model: "nonexistent-model-that-does-not-exist.gguf" })
      ).rejects.toThrow(/GGUF model file not found/);
    });

    it("throws when llama-server binary is not found", async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("lsof")) throw new Error("not found");
        throw new Error("not found");
      });

      const { startServer } = await import("../llm/process-manager");
      await expect(startServer("llama-cpp", { model: "test.gguf" })).rejects.toThrow(
        /llama-server binary not found/
      );
    });

    it("includes -ngl 99 for GPU offloading", async () => {
      // Create a temporary GGUF file to pass validation
      const fs = await import("fs");
      const path = await import("path");
      const ggufDir = path.join(process.cwd(), "data", "models", "gguf");
      fs.mkdirSync(ggufDir, { recursive: true });
      const testFile = path.join(ggufDir, "test-model.gguf");
      fs.writeFileSync(testFile, "fake gguf data");

      try {
        const mockProc = {
          pid: 12345,
          exitCode: null,
          killed: false,
          unref: vi.fn(),
          stdout: { on: vi.fn() },
          stderr: { on: vi.fn() },
          on: vi.fn(),
          kill: vi.fn(),
        };
        mockSpawn.mockReturnValue(mockProc);
        mockExecSync.mockImplementation((cmd: string) => {
          if (typeof cmd === "string" && cmd.includes("which llama-server"))
            return "/usr/local/bin/llama-server";
          if (typeof cmd === "string" && cmd.includes("lsof")) throw new Error("not found");
          return "";
        });

        const { startServer } = await import("../llm/process-manager");
        await startServer("llama-cpp", { model: "test-model.gguf" });

        const spawnCall = mockSpawn.mock.calls.find(
          (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("-ngl")
        );
        expect(spawnCall).toBeDefined();
        const args = spawnCall![1] as string[];
        expect(args).toContain("-ngl");
        expect(args[args.indexOf("-ngl") + 1]).toBe("99");
        expect(args).toContain("--parallel");
      } finally {
        fs.rmSync(testFile, { force: true });
      }
    });
  });
});

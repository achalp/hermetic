/**
 * Process manager for local LLM inference servers (MLX, llama.cpp).
 * Manages subprocess lifecycle: start, stop, health check.
 * Persists PIDs to runtime config so processes survive Next.js hot reloads.
 */
import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync } from "fs";
import { join, isAbsolute } from "path";
import { getRuntimeConfig, setRuntimeConfig } from "@/lib/runtime-config";
import { LOCAL_CTX_SIZE } from "@/lib/constants";
import { logger } from "@/lib/logger";

const MAX_LOG_LINES = 200;

// Use globalThis to survive Next.js HMR — prevents orphan processes
const g = globalThis as unknown as {
  __llmProcesses?: Map<string, ChildProcess>;
  __llmServerLogs?: Map<string, string[]>;
  __llmStartLocks?: Map<string, boolean>;
  __llmStartTimestamps?: Map<string, number>;
};
if (!g.__llmProcesses) g.__llmProcesses = new Map();
if (!g.__llmServerLogs) g.__llmServerLogs = new Map();
if (!g.__llmStartLocks) g.__llmStartLocks = new Map();
if (!g.__llmStartTimestamps) g.__llmStartTimestamps = new Map();
const processes = g.__llmProcesses;
const serverLogs = g.__llmServerLogs;
const startLocks = g.__llmStartLocks;
const startTimestamps = g.__llmStartTimestamps;

const DEFAULT_PORTS: Record<string, number> = {
  mlx: 8080,
  "llama-cpp": 8081,
  ollama: 11434,
};

/** Grace period after spawn before we declare the process dead */
const STARTUP_GRACE_MS = 15_000;

/** Check if a process with the given PID is still alive */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if a port is already in use */
function isPortInUse(port: number): boolean {
  try {
    const output = execSync(`lsof -ti :${port} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/** Health check a running backend */
export async function healthCheck(backend: string): Promise<boolean> {
  const rc = getRuntimeConfig();
  let baseUrl: string;
  let healthUrl: string;

  if (backend === "ollama") {
    baseUrl = rc.ollama?.baseUrl || `http://localhost:${DEFAULT_PORTS.ollama}`;
    healthUrl = `${baseUrl}/api/version`;
  } else if (backend === "mlx") {
    baseUrl = rc.mlx?.baseUrl || `http://localhost:${DEFAULT_PORTS.mlx}`;
    healthUrl = `${baseUrl}/v1/models`;
  } else if (backend === "llama-cpp") {
    baseUrl = rc.llamaCpp?.baseUrl || `http://localhost:${DEFAULT_PORTS["llama-cpp"]}`;
    healthUrl = `${baseUrl}/v1/models`;
  } else {
    return false;
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/** Check if a backend server is running (via tracked process or saved PID) */
export function isRunning(backend: string): boolean {
  // Check in-memory tracked process first
  const proc = processes.get(backend);
  if (proc && proc.exitCode === null) return true;

  // Check saved PID from runtime config
  const rc = getRuntimeConfig();
  const pid =
    backend === "mlx"
      ? rc.mlx?.pid
      : backend === "llama-cpp"
        ? rc.llamaCpp?.pid
        : backend === "ollama"
          ? rc.ollama?.pid
          : undefined;
  if (pid && isPidAlive(pid)) return true;

  return false;
}

/**
 * Check if we're within the startup grace period.
 * Prevents premature "stopped" status when server is still initializing.
 */
export function isWithinStartupGrace(backend: string): boolean {
  const ts = startTimestamps.get(backend);
  if (!ts) return false;
  return Date.now() - ts < STARTUP_GRACE_MS;
}

/** Check if a start operation is already in progress */
export function isStarting(backend: string): boolean {
  return startLocks.get(backend) === true;
}

export interface StartOptions {
  model: string;
  port?: number;
  /** For llama.cpp: path to the GGUF file */
  modelPath?: string;
  /** For llama.cpp: path to llama-server binary */
  binaryPath?: string;
  /** Context window size */
  contextLength?: number;
}

/** Start a local LLM server subprocess */
export async function startServer(
  backend: "mlx" | "llama-cpp" | "ollama",
  options: StartOptions
): Promise<{ pid: number; baseUrl: string }> {
  // Prevent concurrent starts — the most common source of race conditions
  if (startLocks.get(backend)) {
    logger.warn(`startServer: ${backend} start already in progress, ignoring duplicate call`);
    const rc = getRuntimeConfig();
    const config = backend === "mlx" ? rc.mlx : backend === "llama-cpp" ? rc.llamaCpp : rc.ollama;
    return {
      pid: config?.pid ?? 0,
      baseUrl: config?.baseUrl || `http://localhost:${DEFAULT_PORTS[backend]}`,
    };
  }

  startLocks.set(backend, true);
  startTimestamps.set(backend, Date.now());

  try {
    const port = options.port ?? DEFAULT_PORTS[backend];
    const baseUrl = `http://127.0.0.1:${port}`;

    // Stop existing process if any
    await stopServer(backend);

    // Wait briefly for port to free up after stop
    await new Promise((r) => setTimeout(r, 500));

    // Check if port is still in use by something else
    if (isPortInUse(port)) {
      const occupant = findPidByPort(port);
      throw new Error(
        `Port ${port} is already in use${occupant ? ` by PID ${occupant}` : ""}. ` +
          `Stop the existing process or configure a different port.`
      );
    }

    let proc: ChildProcess;

    if (backend === "ollama") {
      proc = spawn("ollama", ["serve"], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` },
      });
    } else if (backend === "mlx") {
      // Prefer the standalone mlx_lm.server command (works with Homebrew installs),
      // fall back to python3 -m mlx_lm.server (works with pip installs)
      let mlxCmd: string;
      let mlxArgs: string[];
      try {
        execSync("which mlx_lm.server", { stdio: "ignore", timeout: 5000 });
        mlxCmd = "mlx_lm.server";
        mlxArgs = ["--model", options.model, "--port", String(port), "--host", "127.0.0.1"];
      } catch {
        mlxCmd = "python3";
        mlxArgs = [
          "-m",
          "mlx_lm.server",
          "--model",
          options.model,
          "--port",
          String(port),
          "--host",
          "127.0.0.1",
        ];
      }

      // Add cache limit to prevent OOM — use 90% of system RAM as ceiling.
      // MLX models use unified memory; without a limit, large models consume
      // everything and the process gets SIGABRT'd by macOS jetsam.
      try {
        const memBytes = parseInt(
          execSync("sysctl -n hw.memsize", { encoding: "utf-8", timeout: 3000 }).trim(),
          10
        );
        const cacheLimitGb = Math.max(4, Math.floor((memBytes / 1024 ** 3) * 0.9));
        mlxArgs.push("--cache-limit", `${cacheLimitGb}gb`);
      } catch {
        // If we can't detect RAM, don't set a limit — MLX will manage
        logger.warn("startServer: could not detect system RAM for cache limit");
      }

      proc = spawn(mlxCmd, mlxArgs, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } else {
      const binary = options.binaryPath || "llama-server";
      let modelPath = options.modelPath || options.model;
      if (!isAbsolute(modelPath) && !existsSync(modelPath)) {
        const resolved = join(process.cwd(), "data", "models", "gguf", modelPath);
        if (existsSync(resolved)) modelPath = resolved;
      }
      const ctxLen = options.contextLength ?? LOCAL_CTX_SIZE;
      proc = spawn(
        binary,
        ["-m", modelPath, "--port", String(port), "--host", "127.0.0.1", "-c", String(ctxLen)],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    }

    // Don't let the child keep the parent alive
    proc.unref();

    // Guard against spawn failure (e.g., binary not found)
    if (!proc.pid) {
      throw new Error(
        `Failed to spawn ${backend} server process. ` +
          `Ensure ${backend === "mlx" ? "mlx_lm" : backend} is installed.`
      );
    }

    const pid = proc.pid;
    processes.set(backend, proc);

    // Capture stdout/stderr into a ring buffer for diagnostics
    const logs: string[] = [];
    serverLogs.set(backend, logs);

    const appendLog = (stream: string, data: Buffer) => {
      const lines = data
        .toString()
        .split(/[\r\n]+/)
        .filter(Boolean);
      for (const line of lines) {
        logs.push(`[${stream}] ${line}`);
        if (logs.length > MAX_LOG_LINES) logs.shift();
      }
    };

    proc.stdout?.on("data", (data: Buffer) => appendLog("stdout", data));
    proc.stderr?.on("data", (data: Buffer) => appendLog("stderr", data));

    // Watch for early exit — wait briefly to catch immediate failures
    // (bad model path, missing dependencies, port conflict, etc.)
    const earlyExitPromise = new Promise<{ code: number | null; signal: string | null } | null>(
      (resolve) => {
        const timer = setTimeout(() => resolve(null), 2000);
        proc.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      }
    );

    // Save PID and config
    if (backend === "ollama") {
      setRuntimeConfig({
        ollama: { enabled: true, baseUrl, activeModel: options.model, pid },
      });
    } else if (backend === "mlx") {
      setRuntimeConfig({
        mlx: { enabled: true, baseUrl, activeModel: options.model, pid },
      });
    } else {
      setRuntimeConfig({
        llamaCpp: {
          enabled: true,
          baseUrl,
          activeModel: options.model,
          pid,
          binaryPath: options.binaryPath,
        },
      });
    }

    // Check for early crash (within 2 seconds)
    const earlyExit = await earlyExitPromise;
    if (earlyExit) {
      const lastLogs = logs.slice(-5).join("\n");
      const exitInfo =
        earlyExit.signal === "SIGABRT"
          ? "Process was killed (SIGABRT) — likely out of memory. Try a smaller model."
          : earlyExit.code !== 0
            ? `Process exited with code ${earlyExit.code}.`
            : "Process exited unexpectedly.";

      // Clean up config
      if (backend === "mlx") {
        setRuntimeConfig({ mlx: { enabled: false, baseUrl: "", activeModel: "", pid: undefined } });
      } else if (backend === "llama-cpp") {
        setRuntimeConfig({
          llamaCpp: { enabled: false, baseUrl: "", activeModel: "", pid: undefined },
        });
      } else {
        setRuntimeConfig({
          ollama: { enabled: false, baseUrl: "", activeModel: "", pid: undefined },
        });
      }

      throw new Error(
        `${backend} server failed to start. ${exitInfo}${lastLogs ? "\n\nLogs:\n" + lastLogs : ""}`
      );
    }

    logger.info(`startServer: ${backend} spawned with PID ${pid}`, {
      model: options.model,
      port,
      baseUrl,
    });

    return { pid, baseUrl };
  } finally {
    startLocks.set(backend, false);
  }
}

/** Find PID of a process listening on a given port (macOS/Linux) */
function findPidByPort(port: number): number | null {
  try {
    const output = execSync(`lsof -ti :${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
    const pid = parseInt(output.split("\n")[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Stop a backend server subprocess */
export async function stopServer(backend: string): Promise<void> {
  logger.info(`stopServer: stopping ${backend}`);

  // Kill tracked process
  const proc = processes.get(backend);
  if (proc && proc.exitCode === null) {
    try {
      // Kill the process group (since we used detached: true)
      process.kill(-proc.pid!, "SIGTERM");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    processes.delete(backend);
  }

  // Also kill by saved PID (handles orphans after HMR)
  const rc = getRuntimeConfig();
  const pid =
    backend === "mlx"
      ? rc.mlx?.pid
      : backend === "llama-cpp"
        ? rc.llamaCpp?.pid
        : backend === "ollama"
          ? rc.ollama?.pid
          : undefined;
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ignore
      }
    }
    // Give it a moment, then force kill
    await new Promise((r) => setTimeout(r, 2000));
    if (isPidAlive(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }

  // Last resort: find orphan process by port (handles cases where PID was lost)
  if (backend !== "ollama") {
    const port = DEFAULT_PORTS[backend];
    if (port) {
      const orphanPid = findPidByPort(port);
      if (orphanPid && orphanPid !== pid && isPidAlive(orphanPid)) {
        logger.info(`stopServer: killing orphan process ${orphanPid} on port ${port}`);
        try {
          process.kill(orphanPid, "SIGTERM");
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 1000));
        if (isPidAlive(orphanPid)) {
          try {
            process.kill(orphanPid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    }
  }

  // Clear startup tracking
  startTimestamps.delete(backend);

  // Clear PID from config
  if (backend === "ollama") {
    setRuntimeConfig({
      ollama: { enabled: false, baseUrl: "", activeModel: "", pid: undefined },
    });
  } else if (backend === "mlx") {
    setRuntimeConfig({ mlx: { enabled: false, baseUrl: "", activeModel: "", pid: undefined } });
  } else if (backend === "llama-cpp") {
    setRuntimeConfig({
      llamaCpp: { enabled: false, baseUrl: "", activeModel: "", pid: undefined },
    });
  }
}

/** Get logs from a running server (last N lines of captured output) */
export function getServerLogs(backend: string): string[] {
  return serverLogs.get(backend) ?? [];
}

// Cleanup on process exit — must be synchronous (no await)
if (typeof process !== "undefined") {
  const cleanup = () => {
    for (const [, proc] of processes) {
      try {
        if (proc.pid && proc.exitCode === null) {
          // Use synchronous kill — exit handlers can't await
          try {
            process.kill(-proc.pid, "SIGTERM");
          } catch {
            proc.kill("SIGTERM");
          }
        }
      } catch {
        // best effort
      }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

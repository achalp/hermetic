/**
 * Process manager for local LLM inference servers (MLX, llama.cpp).
 * Manages subprocess lifecycle: start, stop, health check.
 * Persists PIDs to runtime config so processes survive Next.js hot reloads.
 */
import { spawn, execSync, type ChildProcess } from "child_process";
import { existsSync, readdirSync } from "fs";
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
    // llama-server's /health endpoint is the reliable way to check status.
    // Returns {"status":"ok"} when ready, {"status":"loading model"} during load,
    // or {"status":"error"} on failure. /v1/models may not exist on all builds.
    healthUrl = `${baseUrl}/health`;
  } else {
    return false;
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return false;

    // llama-server /health returns {"status":"ok"} when ready,
    // {"status":"loading model"} during startup — treat loading as not ready
    if (backend === "llama-cpp") {
      try {
        const data = await res.json();
        return data.status === "ok";
      } catch {
        // If we can't parse JSON, accept the 200 as healthy
        return true;
      }
    }

    return true;
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

/** GGUF model directory */
const GGUF_DIR = join(process.cwd(), "data", "models", "gguf");

/**
 * Resolve the llama-server binary path. Checks multiple locations:
 * 1. Explicit binaryPath from user config
 * 2. "llama-server" on PATH (Homebrew/system install)
 * 3. Bundled binary at data/bin/llama-server
 */
function resolveLlamaServerBinary(binaryPath?: string): string {
  if (binaryPath) {
    if (existsSync(binaryPath)) return binaryPath;
    // Might be just the name — try which
    try {
      return execSync(`which ${binaryPath}`, { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
      throw new Error(
        `llama-server binary not found at "${binaryPath}". ` +
          `Install it via Homebrew (brew install llama.cpp) or provide the correct path.`
      );
    }
  }

  // Check PATH
  try {
    return execSync("which llama-server", { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    // not on PATH
  }

  // Check bundled location
  const bundled = join(process.cwd(), "data", "bin", "llama-server");
  if (existsSync(bundled)) return bundled;

  throw new Error(
    "llama-server binary not found. Install it:\n" +
      "  • Homebrew: brew install llama.cpp\n" +
      "  • Or download from: https://github.com/ggml-org/llama.cpp/releases"
  );
}

/**
 * Resolve a GGUF model path from various input formats:
 * - Absolute path → use directly
 * - Bare filename (e.g. "model-Q4_K_M.gguf") → look in GGUF_DIR
 * - HF repo ID (e.g. "bartowski/Llama-GGUF") → scan GGUF_DIR for matching files
 *
 * When a repo has multiple GGUF files (different quant levels), picks the best one:
 * Q4_K_M > Q4_K_S > Q5_K_M > Q5_K_S > Q6_K > Q8_0 > any other
 */
export function resolveGgufModelPath(model: string): string {
  // Absolute path — use directly
  if (isAbsolute(model)) return model;

  // Bare filename — check in GGUF_DIR
  if (model.endsWith(".gguf")) {
    const direct = join(GGUF_DIR, model);
    if (existsSync(direct)) return direct;
    // Search recursively for this filename
    return findGgufFile(model) || direct;
  }

  // HF repo ID like "bartowski/Llama-3.2-3B-Instruct-GGUF"
  // The HF CLI downloads to GGUF_DIR with the original filenames.
  // We need to find the actual .gguf file(s) and pick the best quant.
  const ggufFile = findBestGgufForRepo(model);
  if (ggufFile) return ggufFile;

  // Last resort — try the model string as-is in GGUF_DIR
  const fallback = join(GGUF_DIR, model);
  if (existsSync(fallback)) return fallback;

  // Return the path where we'd expect it — caller will check existsSync
  return join(GGUF_DIR, model);
}

/** Preferred GGUF quant levels for llama.cpp (best quality/speed tradeoff first) */
const QUANT_PREFERENCE = [
  "Q4_K_M",
  "Q4_K_S",
  "Q5_K_M",
  "Q5_K_S",
  "Q6_K",
  "Q8_0",
  "Q3_K_M",
  "Q2_K",
  "IQ4_XS",
];

/**
 * Search GGUF_DIR recursively for a specific filename.
 */
function findGgufFile(filename: string): string | null {
  try {
    const files = readdirSync(GGUF_DIR, { recursive: true }) as string[];
    for (const f of files) {
      if (typeof f === "string" && f.endsWith(filename)) {
        return join(GGUF_DIR, f);
      }
    }
  } catch {
    // dir doesn't exist
  }
  return null;
}

/**
 * Find the best GGUF file matching a HF repo ID.
 * Scans GGUF_DIR for files whose names match the repo's model pattern,
 * then picks the best quantization level.
 */
function findBestGgufForRepo(repoId: string): string | null {
  try {
    if (!existsSync(GGUF_DIR)) return null;
    const files = (readdirSync(GGUF_DIR, { recursive: true }) as string[]).filter(
      (f) => typeof f === "string" && f.endsWith(".gguf")
    );
    if (files.length === 0) return null;

    // Extract the model name from the repo ID (e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF" → "Llama-3.2-3B-Instruct")
    const repoName = repoId.split("/").pop() || "";
    const baseName = repoName.replace(/-GGUF$/i, "").toLowerCase();

    // Filter to files that match this model
    const matching = files.filter((f) => {
      const lower = f.toLowerCase();
      return lower.includes(baseName) || lower.includes(baseName.replace(/-/g, "_"));
    });

    const candidates = matching.length > 0 ? matching : files;

    // If only one GGUF file, use it
    if (candidates.length === 1) return join(GGUF_DIR, candidates[0]);

    // Pick by quant preference
    for (const quant of QUANT_PREFERENCE) {
      const match = candidates.find((f) => f.toUpperCase().includes(quant));
      if (match) return join(GGUF_DIR, match);
    }

    // Fall back to first file
    return join(GGUF_DIR, candidates[0]);
  } catch {
    return null;
  }
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

      // Set Metal cache limit via environment variable to prevent OOM.
      // mlx_lm.server doesn't have a --cache-limit CLI flag, but MLX
      // respects the MLX_METAL_CACHE_LIMIT env var (bytes) to cap GPU
      // memory usage. Without this, large models consume all unified
      // memory and get SIGABRT'd by macOS jetsam.
      const mlxEnv = { ...process.env };
      try {
        const memBytes = parseInt(
          execSync("sysctl -n hw.memsize", { encoding: "utf-8", timeout: 3000 }).trim(),
          10
        );
        // Use 90% of system RAM as the Metal cache ceiling
        const cacheLimitBytes = Math.max(4 * 1024 ** 3, Math.floor(memBytes * 0.9));
        mlxEnv.MLX_METAL_CACHE_LIMIT = String(cacheLimitBytes);
        logger.info("startServer: MLX Metal cache limit set", {
          limitGb: Math.round(cacheLimitBytes / 1024 ** 3),
          systemGb: Math.round(memBytes / 1024 ** 3),
        });
      } catch {
        // If we can't detect RAM, don't set a limit — MLX will manage
        logger.warn("startServer: could not detect system RAM for cache limit");
      }

      proc = spawn(mlxCmd, mlxArgs, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: mlxEnv,
      });
    } else {
      // --- llama.cpp server ---
      // 1. Resolve binary path
      const binary = resolveLlamaServerBinary(options.binaryPath);

      // 2. Resolve model path: the "model" field may be a HF repo ID
      //    (e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"), a bare GGUF filename,
      //    or an absolute path. We need to find the actual .gguf file on disk.
      const modelPath = resolveGgufModelPath(options.modelPath || options.model);

      // 3. Validate the GGUF file actually exists
      if (!existsSync(modelPath)) {
        throw new Error(
          `GGUF model file not found: ${modelPath}\n` +
            `The model may not be downloaded yet, or the filename doesn't match. ` +
            `Download the model first, then try again.`
        );
      }

      const ctxLen = options.contextLength ?? LOCAL_CTX_SIZE;
      const llamaArgs = [
        "-m",
        modelPath,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "-c",
        String(ctxLen),
        "--parallel",
        "1", // explicit single-slot — prevents ambiguous 503 errors
        "-ngl",
        "99", // offload all layers to Metal GPU (Apple Silicon) or CUDA
      ];

      logger.info("startServer: llama-cpp spawn", { binary, modelPath, args: llamaArgs });

      proc = spawn(binary, llamaArgs, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
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

/**
 * Process manager for local LLM inference servers (MLX, llama.cpp).
 * Manages subprocess lifecycle: start, stop, health check.
 * Persists PIDs to runtime config so processes survive Next.js hot reloads.
 */
import { spawn, execSync, type ChildProcess } from "child_process";
import { getRuntimeConfig, setRuntimeConfig } from "@/lib/runtime-config";

const processes = new Map<string, ChildProcess>();
const serverLogs = new Map<string, string[]>();
const MAX_LOG_LINES = 200;

const DEFAULT_PORTS: Record<string, number> = {
  mlx: 8080,
  "llama-cpp": 8081,
  ollama: 11434,
};

/** Check if a process with the given PID is still alive */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll a URL until it responds OK, timeout, or shouldAbort returns true */
async function waitForReady(
  url: string,
  timeoutMs = 60_000,
  shouldAbort?: () => boolean
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (shouldAbort?.()) return false;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
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
  const port = options.port ?? DEFAULT_PORTS[backend];
  const baseUrl = `http://localhost:${port}`;

  // Stop existing process if any
  await stopServer(backend);

  let proc: ChildProcess;

  if (backend === "ollama") {
    // Spawn `ollama serve`
    proc = spawn("ollama", ["serve"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OLLAMA_HOST: `0.0.0.0:${port}` },
    });
  } else if (backend === "mlx") {
    // Prefer the standalone mlx_lm.server command (works with Homebrew installs),
    // fall back to python3 -m mlx_lm.server (works with pip installs)
    let mlxCmd: string;
    let mlxArgs: string[];
    try {
      execSync("which mlx_lm.server", { stdio: "ignore" });
      mlxCmd = "mlx_lm.server";
      mlxArgs = ["--model", options.model, "--port", String(port), "--host", "0.0.0.0"];
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
        "0.0.0.0",
      ];
    }

    proc = spawn(mlxCmd, mlxArgs, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    const binary = options.binaryPath || "llama-server";
    const modelPath = options.modelPath || options.model;
    const ctxLen = options.contextLength ?? 32768;
    proc = spawn(
      binary,
      ["-m", modelPath, "--port", String(port), "--host", "0.0.0.0", "-c", String(ctxLen)],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] }
    );
  }

  // Don't let the child keep the parent alive
  proc.unref();

  const pid = proc.pid!;
  processes.set(backend, proc);

  // Capture stdout/stderr into a ring buffer for diagnostics
  const logs: string[] = [];
  serverLogs.set(backend, logs);

  const appendLog = (stream: string, data: Buffer) => {
    // Split on both \n and \r to capture HuggingFace download progress bars
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

  // Track early exit
  const earlyExit: { value: { code: number | null; signal: string | null } | null } = {
    value: null,
  };
  proc.on("exit", (code, signal) => {
    earlyExit.value = { code, signal };
  });

  // Save PID and config
  if (backend === "ollama") {
    setRuntimeConfig({
      ollama: {
        enabled: true,
        baseUrl,
        activeModel: options.model,
        pid,
      },
    });
  } else if (backend === "mlx") {
    setRuntimeConfig({
      mlx: {
        enabled: true,
        baseUrl,
        activeModel: options.model,
        pid,
      },
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

  // Don't block — return immediately. The client should poll /api/local-llm/status
  // to know when the server is ready. Model loading can take minutes for large models.
  // If the process exits early, the next status check will detect it.

  return { pid, baseUrl };
}

/** Stop a backend server subprocess */
export async function stopServer(backend: string): Promise<void> {
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

  // Also kill by saved PID
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
      process.kill(pid, "SIGTERM");
      // Give it a moment, then force kill
      await new Promise((r) => setTimeout(r, 2000));
      if (isPidAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // already dead
    }
  }

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

// Cleanup on process exit
if (typeof process !== "undefined") {
  const cleanup = () => {
    for (const [backend] of processes) {
      try {
        stopServer(backend);
      } catch {
        // best effort
      }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

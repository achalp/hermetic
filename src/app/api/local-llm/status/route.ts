import { execSync } from "child_process";
import {
  healthCheck,
  isRunning,
  isWithinStartupGrace,
  isStarting,
  getServerLogs,
} from "@/lib/llm/process-manager";
import { getRuntimeConfig, setRuntimeConfig } from "@/lib/runtime-config";
import { getActiveDownloads } from "@/app/api/local-llm/download/route";

/** Get total system RAM in GB (cached after first call) */
let cachedRamGb: number | null = null;
function getSystemRamGb(): number {
  if (cachedRamGb !== null) return cachedRamGb;
  try {
    const bytes = parseInt(
      execSync("sysctl -n hw.memsize", { encoding: "utf-8", timeout: 3000 }).trim(),
      10
    );
    cachedRamGb = Math.round(bytes / (1024 * 1024 * 1024));
  } catch {
    cachedRamGb = 0;
  }
  return cachedRamGb;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const backend = searchParams.get("backend") ?? "mlx";

  const rc = getRuntimeConfig();
  const config =
    backend === "ollama"
      ? rc.ollama
      : backend === "mlx"
        ? rc.mlx
        : backend === "llama-cpp"
          ? rc.llamaCpp
          : null;

  const defaultPort =
    backend === "ollama" ? 11434 : backend === "mlx" ? 8080 : backend === "llama-cpp" ? 8081 : 0;

  const baseUrl = config?.baseUrl || `http://localhost:${defaultPort}`;

  // Check if we spawned it ourselves
  const processAlive = isRunning(backend);

  // Health check — works for all backends (also detects externally-running Ollama)
  const healthy = await healthCheck(backend);

  // For Ollama, also try to get version info when healthy
  let version: string | undefined;
  if (backend === "ollama" && healthy) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${baseUrl}/api/version`, { signal: controller.signal });
      clearTimeout(t);
      if (res.ok) {
        const data = await res.json();
        version = data.version;
      }
    } catch {
      // ignore
    }
  }

  // Extra PID-alive check: isRunning() uses in-memory process map first,
  // which can lose references during Next.js HMR. Fall back to checking
  // the saved PID directly from config as an additional safety net.
  let pidStillAlive = false;
  if (!processAlive && config?.pid) {
    try {
      process.kill(config.pid, 0); // signal 0 = just check if alive
      pidStillAlive = true;
    } catch {
      // process is dead
    }
  }

  // Four states: stopped, starting (process alive or within grace period), ready, crashed
  let status: string;
  if (healthy) {
    status = "ready";
  } else if (
    processAlive ||
    pidStillAlive ||
    isWithinStartupGrace(backend) ||
    isStarting(backend)
  ) {
    // Process is alive but not responding yet, OR we just spawned it (grace period).
    // This covers: model downloading, model loading into GPU, port binding.
    status = "starting";
  } else {
    status = "stopped";
    // Clean up stale PID if the process died (crash, OOM, etc.)
    if (config?.pid) {
      if (backend === "mlx") {
        setRuntimeConfig({ mlx: { ...config, pid: undefined } });
      } else if (backend === "llama-cpp") {
        setRuntimeConfig({ llamaCpp: { ...config, pid: undefined } });
      } else if (backend === "ollama") {
        setRuntimeConfig({ ollama: { ...config, pid: undefined } });
      }
    }
  }

  // Always return logs if available (especially useful when process just died)
  const logs = getServerLogs(backend).slice(-10);

  const systemRamGb = getSystemRamGb();

  // Check for active downloads for this backend
  const downloads = getActiveDownloads(backend);

  return Response.json({
    running: healthy,
    status,
    backend,
    baseUrl,
    activeModel: config?.activeModel || "",
    pid: config?.pid,
    ...(systemRamGb > 0 && { systemRamGb }),
    ...(version && { version }),
    ...(logs.length > 0 && { logs }),
    ...(downloads.length > 0 && { downloads }),
  });
}

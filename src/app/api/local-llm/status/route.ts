import { healthCheck, isRunning, getServerLogs } from "@/lib/llm/process-manager";
import { getRuntimeConfig } from "@/lib/runtime-config";

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

  // Three states: stopped, starting (process alive but not healthy), ready
  let status: string;
  if (healthy) {
    status = "ready";
  } else if (processAlive) {
    status = "starting";
  } else {
    status = "stopped";
  }

  const logs = processAlive && !healthy ? getServerLogs(backend).slice(-5) : [];

  return Response.json({
    running: healthy,
    status,
    backend,
    baseUrl,
    activeModel: config?.activeModel || "",
    pid: config?.pid,
    ...(version && { version }),
    ...(logs.length > 0 && { logs }),
  });
}

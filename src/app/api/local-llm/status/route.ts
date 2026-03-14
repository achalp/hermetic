import { healthCheck, isRunning, getServerLogs } from "@/lib/llm/process-manager";
import { getRuntimeConfig } from "@/lib/runtime-config";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const backend = searchParams.get("backend") ?? "mlx";

  if (backend === "ollama") {
    // Proxy to existing Ollama status logic
    const rc = getRuntimeConfig();
    const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${baseUrl}/api/version`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return Response.json({ running: false, status: "stopped", backend, baseUrl });
      const data = await res.json();
      return Response.json({
        running: true,
        status: "ready",
        backend,
        version: data.version,
        baseUrl,
      });
    } catch {
      return Response.json({ running: false, status: "stopped", backend, baseUrl });
    }
  }

  // MLX or llama-cpp
  const processAlive = isRunning(backend);
  const healthy = processAlive ? await healthCheck(backend) : false;
  const rc = getRuntimeConfig();
  const config = backend === "mlx" ? rc.mlx : rc.llamaCpp;

  // Three states: stopped, starting (process alive but not healthy), ready
  let status: string;
  if (!processAlive) {
    status = "stopped";
  } else if (!healthy) {
    status = "starting";
  } else {
    status = "ready";
  }

  const logs = processAlive && !healthy ? getServerLogs(backend).slice(-5) : [];

  return Response.json({
    running: healthy,
    status,
    backend,
    baseUrl: config?.baseUrl || "",
    activeModel: config?.activeModel || "",
    pid: config?.pid,
    ...(logs.length > 0 && { logs }),
  });
}

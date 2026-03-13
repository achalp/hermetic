import { healthCheck, isRunning } from "@/lib/llm/process-manager";
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
      if (!res.ok) return Response.json({ running: false, backend, baseUrl });
      const data = await res.json();
      return Response.json({ running: true, backend, version: data.version, baseUrl });
    } catch {
      return Response.json({ running: false, backend, baseUrl });
    }
  }

  // MLX or llama-cpp
  const running = isRunning(backend);
  const healthy = running ? await healthCheck(backend) : false;
  const rc = getRuntimeConfig();
  const config = backend === "mlx" ? rc.mlx : rc.llamaCpp;

  return Response.json({
    running: healthy,
    backend,
    baseUrl: config?.baseUrl || "",
    activeModel: config?.activeModel || "",
    pid: config?.pid,
  });
}

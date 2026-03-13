import { getRuntimeConfig } from "@/lib/runtime-config";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const backend = searchParams.get("backend") ?? "mlx";

  if (backend === "ollama") {
    const rc = getRuntimeConfig();
    const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (!res.ok) return Response.json({ error: "Failed to list models" }, { status: 502 });
      const data = await res.json();
      const models = (data.models ?? []).map(
        (m: { name: string; size: number; modified_at: string }) => ({
          name: m.name,
          size: m.size,
          modified_at: m.modified_at,
        })
      );
      return Response.json({ models });
    } catch {
      return Response.json({ error: "Cannot reach Ollama" }, { status: 502 });
    }
  }

  // MLX or llama-cpp: query the running server's /v1/models endpoint
  const rc = getRuntimeConfig();
  const config = backend === "mlx" ? rc.mlx : rc.llamaCpp;
  const baseUrl = config?.baseUrl;

  if (!baseUrl) {
    return Response.json({ models: [] });
  }

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return Response.json({ models: [] });
    const data = await res.json();
    const models = (data.data ?? []).map((m: { id: string }) => ({
      name: m.id,
      size: 0,
      modified_at: "",
    }));
    return Response.json({ models });
  } catch {
    return Response.json({ models: [] });
  }
}

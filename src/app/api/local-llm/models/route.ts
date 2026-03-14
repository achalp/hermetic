import { getRuntimeConfig } from "@/lib/runtime-config";
import { readdirSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

/** Find a Python that has huggingface_hub */
function findHfPython(): string | null {
  for (const py of [
    "python3",
    "/opt/homebrew/opt/mlx-lm/libexec/bin/python3",
    "/opt/homebrew/opt/huggingface-cli/libexec/bin/python3",
  ]) {
    try {
      execSync(`${py} -c "import huggingface_hub"`, { stdio: "ignore" });
      return py;
    } catch {
      /* not found */
    }
  }
  return null;
}

/** Scan HuggingFace cache for downloaded MLX models */
function listCachedMlxModels(): { name: string; size: number; modified_at: string }[] {
  try {
    // Try standalone CLI first
    let output: string | null = null;
    try {
      output = execSync("huggingface-cli scan-cache --json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* not found */
    }

    // Fall back to Python script using scan_cache_dir API
    if (!output) {
      const py = findHfPython();
      if (!py) return [];
      const script = `
import json
from huggingface_hub import scan_cache_dir
info = scan_cache_dir()
repos = [{"repo_id": r.repo_id, "repo_type": r.repo_type, "size_on_disk": r.size_on_disk, "last_accessed": r.last_accessed} for r in info.repos]
print(json.dumps({"repos": repos}))
`;
      output = execSync(`${py} -c '${script}'`, {
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      });
    }

    const data = JSON.parse(output);
    const repos = data.repos ?? [];
    return repos
      .filter((r: { repo_id: string; repo_type: string }) => r.repo_type === "model")
      .map((r: { repo_id: string; size_on_disk: number; last_accessed: number }) => ({
        name: r.repo_id,
        size: r.size_on_disk ?? 0,
        modified_at: r.last_accessed ? new Date(r.last_accessed * 1000).toISOString() : "",
      }));
  } catch {
    return [];
  }
}

/** Scan data/models/gguf/ for downloaded GGUF files */
function listCachedGgufModels(): { name: string; size: number; modified_at: string }[] {
  const dir = join(process.cwd(), "data", "models", "gguf");
  try {
    const files = readdirSync(dir, { recursive: true }) as string[];
    return files
      .filter((f) => f.endsWith(".gguf"))
      .map((f) => {
        const fullPath = join(dir, f);
        const s = statSync(fullPath);
        return {
          name: f,
          size: s.size,
          modified_at: s.mtime.toISOString(),
        };
      });
  } catch {
    return [];
  }
}

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

  if (backend === "mlx") {
    // First try the running server, then fall back to cache scan
    const rc = getRuntimeConfig();
    const baseUrl = rc.mlx?.baseUrl;
    if (baseUrl) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
        clearTimeout(t);
        if (res.ok) {
          const data = await res.json();
          const serverModels = (data.data ?? []).map((m: { id: string }) => ({
            name: m.id,
            size: 0,
            modified_at: "",
          }));
          if (serverModels.length > 0) {
            // Merge with cache info for sizes
            const cached = listCachedMlxModels();
            const cacheMap = new Map(cached.map((c) => [c.name, c]));
            const merged = serverModels.map(
              (m: { name: string; size: number; modified_at: string }) => ({
                ...m,
                size: cacheMap.get(m.name)?.size ?? m.size,
              })
            );
            return Response.json({ models: merged });
          }
        }
      } catch {
        // server not reachable, fall through to cache
      }
    }
    // Scan HuggingFace cache for downloaded MLX models
    const cached = listCachedMlxModels();
    return Response.json({ models: cached });
  }

  if (backend === "llama-cpp") {
    // First try the running server, then fall back to local scan
    const rc = getRuntimeConfig();
    const baseUrl = rc.llamaCpp?.baseUrl;
    if (baseUrl) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal });
        clearTimeout(t);
        if (res.ok) {
          const data = await res.json();
          const models = (data.data ?? []).map((m: { id: string }) => ({
            name: m.id,
            size: 0,
            modified_at: "",
          }));
          if (models.length > 0) return Response.json({ models });
        }
      } catch {
        // fall through
      }
    }
    const cached = listCachedGgufModels();
    return Response.json({ models: cached });
  }

  return Response.json({ models: [] });
}

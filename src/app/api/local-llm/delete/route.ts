import { execSync } from "child_process";
import { rmSync, readdirSync } from "fs";
import { join } from "path";

export async function POST(request: Request) {
  const body = await request.json();
  const { backend, model } = body;

  if (!model) {
    return Response.json({ error: "model is required" }, { status: 400 });
  }

  if (backend === "ollama") {
    const { getRuntimeConfig } = await import("@/lib/runtime-config");
    const rc = getRuntimeConfig();
    const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";
    try {
      const res = await fetch(`${baseUrl}/api/delete`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
      });
      if (!res.ok) {
        return Response.json({ error: "Failed to delete model" }, { status: 502 });
      }
      return Response.json({ success: true });
    } catch {
      return Response.json({ error: "Cannot reach Ollama" }, { status: 502 });
    }
  }

  if (backend === "mlx") {
    // HuggingFace cache: ~/.cache/huggingface/hub/models--{org}--{name}
    const cacheDir = join(
      process.env.HF_HOME || join(process.env.HOME || "~", ".cache", "huggingface"),
      "hub"
    );
    // model is like "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit"
    const dirName = `models--${model.replace(/\//g, "--")}`;
    const fullPath = join(cacheDir, dirName);

    try {
      // Verify the directory exists and is inside the cache
      if (!fullPath.startsWith(cacheDir)) {
        return Response.json({ error: "Invalid model path" }, { status: 400 });
      }
      rmSync(fullPath, { recursive: true, force: true });
      return Response.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete model";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  if (backend === "llama-cpp") {
    // GGUF files in data/models/gguf/
    const ggufDir = join(process.cwd(), "data", "models", "gguf");
    const fullPath = join(ggufDir, model);

    try {
      if (!fullPath.startsWith(ggufDir)) {
        return Response.json({ error: "Invalid model path" }, { status: 400 });
      }
      rmSync(fullPath, { force: true });
      return Response.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete model";
      return Response.json({ error: message }, { status: 500 });
    }
  }

  return Response.json({ error: "Unknown backend" }, { status: 400 });
}

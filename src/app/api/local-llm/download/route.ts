import { spawn } from "child_process";

export async function POST(request: Request) {
  const body = await request.json();
  const { backend, model } = body;

  if (!model) {
    return Response.json({ error: "model is required" }, { status: 400 });
  }

  if (backend === "ollama") {
    // Proxy to Ollama pull
    const { getRuntimeConfig } = await import("@/lib/runtime-config");
    const rc = getRuntimeConfig();
    const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";
    const res = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) {
      return Response.json({ error: "Failed to pull model" }, { status: 502 });
    }
    return new Response(res.body, {
      headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
    });
  }

  if (backend === "mlx") {
    // Use huggingface-cli download to fetch the model
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        const emit = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };

        emit({ status: `Downloading ${model}...`, progress: 0 });

        const proc = spawn(
          "python3",
          ["-m", "huggingface_hub.commands.huggingface_cli", "download", model],
          {
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        let lastLine = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          lastLine = text.trim().split("\n").pop() ?? lastLine;
          // Try to parse percentage from huggingface-cli output
          const pctMatch = lastLine.match(/(\d+)%/);
          if (pctMatch) {
            emit({ status: `Downloading...`, progress: parseInt(pctMatch[1]) });
          } else {
            emit({ status: lastLine.slice(0, 100) });
          }
        });

        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) emit({ status: text.slice(0, 100) });
        });

        proc.on("close", (code) => {
          if (code === 0) {
            emit({ status: "Download complete", progress: 100, done: true });
          } else {
            emit({ status: `Download failed (exit code ${code})`, error: true });
          }
          controller.close();
        });

        proc.on("error", (err) => {
          emit({ status: `Failed to start download: ${err.message}`, error: true });
          controller.close();
        });
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
    });
  }

  if (backend === "llama-cpp") {
    // Download GGUF from HuggingFace
    // model format: "org/repo/filename.gguf" or a full HF URL
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        const emit = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };

        emit({ status: `Downloading ${model}...`, progress: 0 });

        // Use huggingface-cli for GGUF download too
        const proc = spawn(
          "python3",
          [
            "-m",
            "huggingface_hub.commands.huggingface_cli",
            "download",
            ...model.split("/").slice(0, 2),
            "--include",
            "*.gguf",
            "--local-dir",
            `${process.cwd()}/data/models/gguf`,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
          }
        );

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          const pctMatch = text.match(/(\d+)%/);
          if (pctMatch) {
            emit({ status: "Downloading...", progress: parseInt(pctMatch[1]) });
          } else if (text) {
            emit({ status: text.slice(0, 100) });
          }
        });

        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) emit({ status: text.slice(0, 100) });
        });

        proc.on("close", (code) => {
          if (code === 0) {
            emit({ status: "Download complete", progress: 100, done: true });
          } else {
            emit({ status: `Download failed (exit code ${code})`, error: true });
          }
          controller.close();
        });

        proc.on("error", (err) => {
          emit({ status: `Failed to start download: ${err.message}`, error: true });
          controller.close();
        });
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
    });
  }

  return Response.json({ error: "Unknown backend" }, { status: 400 });
}

import { spawn, execSync } from "child_process";

/**
 * Find a working Python that can download from HuggingFace.
 * Returns the python command and whether it has the full CLI module
 * or only the snapshot_download API.
 */
function findHfPython(): { python: string; hasCli: boolean } {
  // 1. Standalone huggingface-cli on PATH — use system python (irrelevant, but marks hasCli)
  try {
    execSync("which huggingface-cli", { stdio: "ignore" });
    return { python: "huggingface-cli", hasCli: true };
  } catch {
    /* not found */
  }

  // 2. Check various pythons for the full CLI module, then snapshot_download
  const pythons = [
    "python3",
    "/opt/homebrew/opt/mlx-lm/libexec/bin/python3",
    "/opt/homebrew/opt/huggingface-cli/libexec/bin/python3",
  ];

  for (const py of pythons) {
    try {
      execSync(`${py} -c "import huggingface_hub.commands"`, { stdio: "ignore" });
      return { python: py, hasCli: true };
    } catch {
      /* not found */
    }
  }

  for (const py of pythons) {
    try {
      execSync(`${py} -c "from huggingface_hub import snapshot_download"`, { stdio: "ignore" });
      return { python: py, hasCli: false };
    } catch {
      /* not found */
    }
  }

  return { python: "python3", hasCli: false };
}

/** Spawn a download process for a HuggingFace model */
function spawnHfDownload(model: string): ReturnType<typeof spawn> {
  const { python, hasCli } = findHfPython();

  if (hasCli) {
    if (python === "huggingface-cli") {
      return spawn("huggingface-cli", ["download", model], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
    return spawn(python, ["-m", "huggingface_hub.commands.huggingface_cli", "download", model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // Fallback: inline snapshot_download script
  const script = `
import sys
from huggingface_hub import snapshot_download
path = snapshot_download(sys.argv[1])
print(path)
`;
  return spawn(python, ["-c", script, model], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

        const proc = spawnHfDownload(model);

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

        const { python, hasCli } = findHfPython();
        const repoId = model.split("/").slice(0, 2).join("/");
        const localDir = `${process.cwd()}/data/models/gguf`;

        let proc: ReturnType<typeof spawn>;
        if (hasCli) {
          const cmd = python === "huggingface-cli" ? "huggingface-cli" : python;
          const args =
            python === "huggingface-cli"
              ? ["download", repoId, "--include", "*.gguf", "--local-dir", localDir]
              : [
                  "-m",
                  "huggingface_hub.commands.huggingface_cli",
                  "download",
                  repoId,
                  "--include",
                  "*.gguf",
                  "--local-dir",
                  localDir,
                ];
          proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
        } else {
          const script = `
import sys
from huggingface_hub import snapshot_download
path = snapshot_download(sys.argv[1], allow_patterns=["*.gguf"], local_dir=sys.argv[2])
print(path)
`;
          proc = spawn(python, ["-c", script, repoId, localDir], {
            stdio: ["ignore", "pipe", "pipe"],
          });
        }

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

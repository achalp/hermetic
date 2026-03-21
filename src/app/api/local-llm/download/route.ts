import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";

// ── Active download tracker ─────────────────────────────────────
// Tracks spawned download processes so the UI can detect ongoing downloads
// even after page refresh / stream disconnect.

export interface ActiveDownload {
  backend: string;
  model: string;
  pid: number;
  startedAt: number;
  progress: number;
  status: string;
}

const activeDownloads = new Map<string, { proc: ChildProcess; info: ActiveDownload }>();

function trackDownload(backend: string, model: string, proc: ChildProcess): void {
  const key = `${backend}:${model}`;
  const info: ActiveDownload = {
    backend,
    model,
    pid: proc.pid ?? 0,
    startedAt: Date.now(),
    progress: 0,
    status: "Downloading...",
  };
  activeDownloads.set(key, { proc, info });
  proc.on("close", () => activeDownloads.delete(key));
  proc.on("error", () => activeDownloads.delete(key));
}

function updateDownloadProgress(
  backend: string,
  model: string,
  progress: number,
  status: string
): void {
  const entry = activeDownloads.get(`${backend}:${model}`);
  if (entry) {
    entry.info.progress = progress;
    entry.info.status = status;
  }
}

/** Get all active downloads, optionally filtered by backend */
export function getActiveDownloads(backend?: string): ActiveDownload[] {
  const results: ActiveDownload[] = [];
  for (const { info } of activeDownloads.values()) {
    if (!backend || info.backend === backend) results.push(info);
  }
  return results;
}

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

/**
 * Quick check whether a HuggingFace repo looks MLX-compatible.
 * MLX needs safetensors weights — repos with only .bin / .pt files will crash.
 */
async function checkMlxCompatibility(model: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${encodeURIComponent(model)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: true }; // Can't verify — let the download proceed
    const data = await res.json();
    const siblings: Array<{ rfilename: string }> = data.siblings ?? [];
    const hasSafetensors = siblings.some((f: { rfilename: string }) =>
      f.rfilename.endsWith(".safetensors")
    );
    if (!hasSafetensors) {
      return {
        ok: false,
        reason:
          `${model} does not contain safetensors weights and is not compatible with MLX. ` +
          `Look for an MLX-converted version (e.g. from mlx-community) or choose a different model.`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: true }; // Network error — don't block
  }
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
    // Validate model has safetensors before downloading
    const compat = await checkMlxCompatibility(model);
    if (!compat.ok) {
      return Response.json({ error: compat.reason }, { status: 400 });
    }

    // Use huggingface-cli download to fetch the model
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        let closed = false;
        const emit = (data: Record<string, unknown>) => {
          if (closed) return;
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          controller.close();
        };

        emit({ status: `Downloading ${model}...`, progress: 0 });

        const proc = spawnHfDownload(model);
        trackDownload("mlx", model, proc);

        let lastLine = "";
        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          lastLine = text.trim().split("\n").pop() ?? lastLine;
          // Try to parse percentage from huggingface-cli output
          const pctMatch = lastLine.match(/(\d+)%/);
          if (pctMatch) {
            const pct = parseInt(pctMatch[1]);
            emit({ status: `Downloading...`, progress: pct });
            updateDownloadProgress("mlx", model, pct, "Downloading...");
          } else {
            emit({ status: lastLine.slice(0, 100) });
            updateDownloadProgress("mlx", model, 0, lastLine.slice(0, 100));
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
          close();
        });

        proc.on("error", (err) => {
          emit({ status: `Failed to start download: ${err.message}`, error: true });
          close();
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
        let closed = false;
        const emit = (data: Record<string, unknown>) => {
          if (closed) return;
          controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
        };
        const close = () => {
          if (closed) return;
          closed = true;
          controller.close();
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

        trackDownload("llama-cpp", model, proc);

        proc.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trim();
          const pctMatch = text.match(/(\d+)%/);
          if (pctMatch) {
            const pct = parseInt(pctMatch[1]);
            emit({ status: "Downloading...", progress: pct });
            updateDownloadProgress("llama-cpp", model, pct, "Downloading...");
          } else if (text) {
            emit({ status: text.slice(0, 100) });
            updateDownloadProgress("llama-cpp", model, 0, text.slice(0, 100));
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
          close();
        });

        proc.on("error", (err) => {
          emit({ status: `Failed to start download: ${err.message}`, error: true });
          close();
        });
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
    });
  }

  return Response.json({ error: "Unknown backend" }, { status: 400 });
}

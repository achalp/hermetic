import { spawn, execSync } from "child_process";
import type { ChildProcess } from "child_process";
import { logger } from "@/lib/logger";

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

/** Max time a download can run before we consider it stuck (30 minutes) */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** If no progress change for this long, the download is stalled (5 minutes) */
const STALL_TIMEOUT_MS = 5 * 60_000;

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

  const cleanup = () => {
    activeDownloads.delete(key);
    logger.debug(`download: cleaned up tracker for ${key}`);
  };
  proc.on("close", cleanup);
  proc.on("error", cleanup);
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

/** Get all active downloads, optionally filtered by backend. Cleans up stale entries. */
export function getActiveDownloads(backend?: string): ActiveDownload[] {
  const results: ActiveDownload[] = [];
  const now = Date.now();

  for (const [key, { proc, info }] of activeDownloads.entries()) {
    // Clean up entries for processes that died without triggering close/error events
    if (proc.exitCode !== null || proc.killed) {
      activeDownloads.delete(key);
      continue;
    }
    // Clean up downloads that exceeded the maximum timeout
    if (now - info.startedAt > DOWNLOAD_TIMEOUT_MS) {
      logger.warn(
        `download: killing timed-out download for ${key} (started ${Math.round((now - info.startedAt) / 60000)}m ago)`
      );
      try {
        proc.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      activeDownloads.delete(key);
      continue;
    }
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
  // 1. Standalone huggingface-cli on PATH
  try {
    execSync("which huggingface-cli", { stdio: "ignore", timeout: 5000 });
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
      execSync(`${py} -c "import huggingface_hub.commands"`, { stdio: "ignore", timeout: 5000 });
      return { python: py, hasCli: true };
    } catch {
      /* not found */
    }
  }

  for (const py of pythons) {
    try {
      execSync(`${py} -c "from huggingface_hub import snapshot_download"`, {
        stdio: "ignore",
        timeout: 5000,
      });
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
    try {
      const res = await fetch(`${baseUrl}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model, stream: true }),
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) {
        return Response.json({ error: "Failed to pull model" }, { status: 502 });
      }
      return new Response(res.body, {
        headers: { "Content-Type": "application/x-ndjson", "Transfer-Encoding": "chunked" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to pull model";
      return Response.json({ error: msg }, { status: 502 });
    }
  }

  if (backend === "mlx") {
    // Prevent duplicate downloads of the same model
    const downloadKey = `mlx:${model}`;
    if (activeDownloads.has(downloadKey)) {
      const existing = activeDownloads.get(downloadKey)!;
      return Response.json(
        {
          error: `Download already in progress (${existing.info.progress}% complete)`,
        },
        { status: 409 }
      );
    }

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
          try {
            controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
          } catch {
            // Controller may be closed if client disconnected
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        emit({ status: `Downloading ${model}...`, progress: 0 });

        const proc = spawnHfDownload(model);

        // Guard against spawn failure
        if (!proc.pid) {
          emit({
            status: "Failed to start download process. Is Python/huggingface-cli installed?",
            error: true,
          });
          close();
          return;
        }

        trackDownload("mlx", model, proc);

        // Stall detection — kill process if no progress for STALL_TIMEOUT_MS
        let lastProgressTime = Date.now();
        let lastProgress = 0;
        const stallChecker = setInterval(() => {
          const entry = activeDownloads.get(downloadKey);
          if (!entry) {
            clearInterval(stallChecker);
            return;
          }
          // Check if progress has changed
          if (entry.info.progress !== lastProgress) {
            lastProgress = entry.info.progress;
            lastProgressTime = Date.now();
          } else if (Date.now() - lastProgressTime > STALL_TIMEOUT_MS) {
            logger.warn(
              `download: killing stalled download for ${model} (no progress for ${Math.round(STALL_TIMEOUT_MS / 60000)}m)`
            );
            try {
              proc.kill("SIGTERM");
            } catch {
              /* already dead */
            }
            emit({
              status: "Download stalled (no progress for 5 minutes). Try again.",
              error: true,
            });
            close();
            clearInterval(stallChecker);
          }
        }, 30_000);

        // Overall timeout
        const overallTimeout = setTimeout(() => {
          if (proc.exitCode === null) {
            logger.warn(`download: killing timed-out download for ${model}`);
            try {
              proc.kill("SIGTERM");
            } catch {
              /* already dead */
            }
            emit({ status: "Download timed out (30 minutes). Try again.", error: true });
            close();
          }
        }, DOWNLOAD_TIMEOUT_MS);

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
          clearInterval(stallChecker);
          clearTimeout(overallTimeout);
          if (code === 0) {
            emit({ status: "Download complete", progress: 100, done: true });
          } else {
            emit({ status: `Download failed (exit code ${code})`, error: true });
          }
          close();
        });

        proc.on("error", (err) => {
          clearInterval(stallChecker);
          clearTimeout(overallTimeout);
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
    // Prevent duplicate downloads
    const downloadKey = `llama-cpp:${model}`;
    if (activeDownloads.has(downloadKey)) {
      const existing = activeDownloads.get(downloadKey)!;
      return Response.json(
        {
          error: `Download already in progress (${existing.info.progress}% complete)`,
        },
        { status: 409 }
      );
    }

    // Download GGUF from HuggingFace
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      start(controller) {
        let closed = false;
        const emit = (data: Record<string, unknown>) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(data) + "\n"));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
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

        if (!proc.pid) {
          emit({
            status: "Failed to start download process. Is Python/huggingface-cli installed?",
            error: true,
          });
          close();
          return;
        }

        trackDownload("llama-cpp", model, proc);

        // Stall detection
        let lastProgressTime = Date.now();
        let lastProgress = 0;
        const stallChecker = setInterval(() => {
          const entry = activeDownloads.get(downloadKey);
          if (!entry) {
            clearInterval(stallChecker);
            return;
          }
          if (entry.info.progress !== lastProgress) {
            lastProgress = entry.info.progress;
            lastProgressTime = Date.now();
          } else if (Date.now() - lastProgressTime > STALL_TIMEOUT_MS) {
            logger.warn(`download: killing stalled download for ${model}`);
            try {
              proc.kill("SIGTERM");
            } catch {
              /* */
            }
            emit({ status: "Download stalled. Try again.", error: true });
            close();
            clearInterval(stallChecker);
          }
        }, 30_000);

        const overallTimeout = setTimeout(() => {
          if (proc.exitCode === null) {
            try {
              proc.kill("SIGTERM");
            } catch {
              /* */
            }
            emit({ status: "Download timed out. Try again.", error: true });
            close();
          }
        }, DOWNLOAD_TIMEOUT_MS);

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
          clearInterval(stallChecker);
          clearTimeout(overallTimeout);
          if (code === 0) {
            emit({ status: "Download complete", progress: 100, done: true });
          } else {
            emit({ status: `Download failed (exit code ${code})`, error: true });
          }
          close();
        });

        proc.on("error", (err) => {
          clearInterval(stallChecker);
          clearTimeout(overallTimeout);
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

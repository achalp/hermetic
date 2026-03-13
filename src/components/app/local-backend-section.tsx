"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RECOMMENDED_MLX_MODELS,
  RECOMMENDED_LLAMACPP_MODELS,
  RECOMMENDED_OLLAMA_MODELS,
} from "@/lib/constants";
import type { LocalBackendId } from "@/lib/constants";

interface BackendModel {
  name: string;
  size: number;
  modified_at: string;
}

interface LocalBackendSectionProps {
  backend: LocalBackendId;
  onProviderChange: (provider: LocalBackendId, model: string) => void;
  isActive: boolean;
  activeModel: string | null;
}

const BACKEND_LABELS: Record<LocalBackendId, string> = {
  mlx: "MLX",
  "llama-cpp": "llama.cpp",
  ollama: "Ollama",
};

const RECOMMENDED_MODELS: Record<
  LocalBackendId,
  readonly { id: string; label: string; description: string; tag: string }[]
> = {
  mlx: RECOMMENDED_MLX_MODELS,
  "llama-cpp": RECOMMENDED_LLAMACPP_MODELS,
  ollama: RECOMMENDED_OLLAMA_MODELS,
};

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function LocalBackendSection({
  backend,
  onProviderChange,
  isActive,
  activeModel,
}: LocalBackendSectionProps) {
  const [status, setStatus] = useState<{
    running: boolean;
    version?: string;
    baseUrl?: string;
    pid?: number;
  } | null>(null);
  const [models, setModels] = useState<BackendModel[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState(0);
  const [pullStatus, setPullStatus] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const statusChecked = useRef(false);

  const label = BACKEND_LABELS[backend];
  const isManaged = backend === "mlx" || backend === "llama-cpp";

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/local-llm/status?backend=${backend}`);
      const data = await res.json();
      setStatus(data);
      if (data.running) {
        fetchModels();
      }
    } catch {
      setStatus({ running: false });
    }
  }, [backend]);

  const fetchModels = async () => {
    try {
      const res = await fetch(`/api/local-llm/models?backend=${backend}`);
      if (res.ok) {
        const data = await res.json();
        setModels(data.models ?? []);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (statusChecked.current) return;
    statusChecked.current = true;
    checkStatus();
  }, [checkStatus]);

  // Reset when backend changes
  useEffect(() => {
    statusChecked.current = false;
    setStatus(null);
    setModels([]);
    setError(null);
    checkStatus();
  }, [backend, checkStatus]);

  const activateModel = async (modelName: string) => {
    setError(null);
    try {
      const res = await fetch("/api/local-llm/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, enabled: true, activeModel: modelName }),
      });
      if (!res.ok) throw new Error("Failed to save config");
      onProviderChange(backend, modelName);
    } catch {
      setError("Failed to activate model");
    }
  };

  const deactivate = async () => {
    setError(null);
    try {
      await fetch("/api/local-llm/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, enabled: false, activeModel: "" }),
      });
      onProviderChange(backend, "");
    } catch {
      setError("Failed to deactivate");
    }
  };

  const startServer = async (modelName: string) => {
    setError(null);
    setStarting(true);
    try {
      const res = await fetch("/api/local-llm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, model: modelName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start server");
      await checkStatus();
      await activateModel(modelName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start server");
    } finally {
      setStarting(false);
    }
  };

  const stopServer = async () => {
    setError(null);
    setStopping(true);
    try {
      await fetch("/api/local-llm/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend }),
      });
      await deactivate();
      await checkStatus();
    } catch {
      setError("Failed to stop server");
    } finally {
      setStopping(false);
    }
  };

  const downloadModel = async (modelName: string) => {
    setError(null);
    setPulling(modelName);
    setPullProgress(0);
    setPullStatus("Starting download...");

    try {
      const res = await fetch("/api/local-llm/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, model: modelName }),
      });

      if (!res.ok) throw new Error("Failed to start download");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.status) setPullStatus(msg.status);
            if (msg.progress != null) setPullProgress(msg.progress);
            if (msg.total && msg.completed) {
              setPullProgress(Math.round((msg.completed / msg.total) * 100));
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      await fetchModels();
    } catch {
      setError(`Failed to download ${modelName}`);
    } finally {
      setPulling(null);
      setPullProgress(0);
      setPullStatus("");
    }
  };

  const recommended = RECOMMENDED_MODELS[backend] ?? [];
  const installedNames = new Set(models.map((m) => m.name));
  const recommendedNotInstalled = recommended.filter((r) => !installedNames.has(r.id));

  // Loading state
  if (!status) {
    return <div className="text-xs text-t-tertiary">Checking {label}...</div>;
  }

  // Not running
  if (!status.running) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="text-xs font-medium text-t-secondary">Not running</span>
        </div>

        {isActive && (
          <div
            className="mb-3 p-2.5 text-xs border border-error-text/30 bg-error-text/5"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            <p className="text-error-text font-medium mb-1.5">
              {label} is the active provider but is not reachable.
            </p>
            <button
              onClick={deactivate}
              className="px-2.5 py-1 text-xs font-medium border border-error-text text-error-text hover:bg-error-text hover:text-white transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Deactivate
            </button>
          </div>
        )}

        {error && <p className="mb-2 text-xs text-error-text">{error}</p>}

        {/* For managed backends, show a start button with model selection */}
        {isManaged && recommended.length > 0 && !pulling && (
          <div className="mb-3">
            <label className="mb-1.5 block text-xs font-medium text-t-secondary">
              Start with a model
            </label>
            <div className="space-y-1">
              {recommended.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 border border-border-default"
                  style={{ borderRadius: "var(--radius-badge)" }}
                >
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-t-primary truncate block">
                      {r.label}
                    </span>
                    <span className="text-[11px] text-t-tertiary">{r.description}</span>
                  </div>
                  <button
                    onClick={() => startServer(r.id)}
                    disabled={starting}
                    className="shrink-0 px-2 py-0.5 text-[11px] font-medium border border-accent text-accent hover:bg-accent hover:text-white disabled:opacity-40 transition-colors"
                    style={{
                      borderRadius: "var(--radius-badge)",
                      transitionDuration: "var(--transition-speed)",
                    }}
                  >
                    {starting ? "Starting..." : "Start"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pull progress */}
        {pulling && (
          <DownloadProgress pulling={pulling} progress={pullProgress} status={pullStatus} />
        )}

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              statusChecked.current = false;
              checkStatus();
            }}
            className="text-xs px-2.5 py-1 border border-border-default text-t-secondary hover:text-t-primary hover:bg-surface-btn transition-colors"
            style={{
              borderRadius: "var(--radius-badge)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            Check again
          </button>
        </div>
      </div>
    );
  }

  // Running
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-xs font-medium text-t-secondary">
          Running{status.version ? ` v${status.version}` : ""}
        </span>
        {isActive && activeModel && (
          <span
            className="ml-auto inline-flex items-center px-2 py-0.5 text-[11px] font-medium bg-accent-subtle text-accent-text"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            {activeModel}
          </span>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-error-text">{error}</p>}

      {/* Active model controls */}
      {isActive && activeModel && (
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-t-secondary">Active Model</label>
          <div className="flex items-center gap-2">
            {models.length > 0 ? (
              <select
                value={activeModel}
                onChange={(e) => activateModel(e.target.value)}
                className="flex-1 border border-border-default bg-surface-input px-2 py-1.5 text-sm text-t-primary"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                    {formatSize(m.size) ? ` (${formatSize(m.size)})` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <span className="flex-1 text-xs text-t-secondary font-mono">{activeModel}</span>
            )}
            <button
              onClick={isManaged ? stopServer : deactivate}
              disabled={stopping}
              className="px-2 py-1.5 text-xs border border-border-default text-t-secondary hover:text-error-text hover:border-error-text transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
              title={isManaged ? "Stop server" : "Deactivate"}
            >
              {stopping ? "..." : isManaged ? "Stop" : "Off"}
            </button>
          </div>
        </div>
      )}

      {/* Installed models (when not active) */}
      {models.length > 0 && !(isActive && activeModel) && (
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-t-secondary">
            {isManaged ? "Available Models" : "Installed Models"}
          </label>
          <div className="space-y-1">
            {models.map((m) => (
              <div
                key={m.name}
                className="flex items-center justify-between gap-2 px-2 py-1.5 border border-border-default"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                <div className="min-w-0">
                  <span className="text-xs font-medium text-t-primary truncate block">
                    {m.name}
                  </span>
                  {formatSize(m.size) && (
                    <span className="text-[11px] text-t-tertiary">{formatSize(m.size)}</span>
                  )}
                </div>
                <button
                  onClick={() => (isManaged ? startServer(m.name) : activateModel(m.name))}
                  disabled={starting}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium bg-accent-subtle text-accent-text hover:bg-accent hover:text-white disabled:opacity-40 transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  {starting ? "Starting..." : isManaged ? "Start" : "Activate"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pull progress */}
      {pulling && (
        <DownloadProgress pulling={pulling} progress={pullProgress} status={pullStatus} />
      )}

      {/* Recommended models */}
      {recommendedNotInstalled.length > 0 && !pulling && (
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-t-secondary">
            Recommended Models
          </label>
          <div className="space-y-1">
            {recommendedNotInstalled.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-2 px-2 py-1.5 border border-border-default"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                <div className="min-w-0">
                  <span className="text-xs font-medium text-t-primary truncate block">
                    {r.label || r.id}
                  </span>
                  <span className="text-[11px] text-t-tertiary">{r.description}</span>
                </div>
                <button
                  onClick={() => downloadModel(r.id)}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  Download
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom model input */}
      {!pulling && (
        <div>
          <label className="mb-1 block text-xs font-medium text-t-secondary">
            {backend === "ollama" ? "Pull Custom Model" : "Download Custom Model"}
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder={
                backend === "mlx"
                  ? "e.g. mlx-community/Qwen2.5-Coder-14B-Instruct-4bit"
                  : backend === "llama-cpp"
                    ? "e.g. bartowski/Qwen2.5-Coder-14B-Instruct-GGUF"
                    : "e.g. mistral:7b or hf.co/user/repo"
              }
              className="flex-1 border border-border-default bg-surface-input px-2 py-1.5 text-xs text-t-primary placeholder:text-t-tertiary"
              style={{ borderRadius: "var(--radius-badge)" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customModel.trim()) {
                  downloadModel(customModel.trim());
                  setCustomModel("");
                }
              }}
            />
            <button
              onClick={() => {
                if (customModel.trim()) {
                  downloadModel(customModel.trim());
                  setCustomModel("");
                }
              }}
              disabled={!customModel.trim()}
              className="shrink-0 px-2.5 py-1.5 text-xs font-medium border border-border-default text-t-secondary hover:text-t-primary hover:bg-surface-btn disabled:opacity-40 transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Download
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function DownloadProgress({
  pulling,
  progress,
  status,
}: {
  pulling: string;
  progress: number;
  status: string;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-t-secondary">Downloading {pulling}...</span>
        <span className="text-xs text-t-tertiary">{progress}%</span>
      </div>
      <div
        className="h-1.5 w-full bg-surface-input overflow-hidden"
        style={{ borderRadius: "var(--radius-badge)" }}
      >
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${progress}%`, transitionDuration: "var(--transition-speed)" }}
        />
      </div>
      <p className="mt-1 text-[11px] text-t-tertiary truncate">{status}</p>
    </div>
  );
}

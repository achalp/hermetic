"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RECOMMENDED_OLLAMA_MODELS } from "@/lib/constants";

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

interface OllamaSectionProps {
  onProviderChange: (provider: "ollama", model: string) => void;
  isActive: boolean;
  activeModel: string | null;
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

export function OllamaSection({ onProviderChange, isActive, activeModel }: OllamaSectionProps) {
  const [status, setStatus] = useState<{
    running: boolean;
    version?: string;
    baseUrl: string;
  } | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState(0);
  const [pullStatus, setPullStatus] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const statusChecked = useRef(false);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/ollama/status");
      const data = await res.json();
      setStatus(data);
      if (data.running) {
        fetchModels();
      }
    } catch {
      setStatus({ running: false, baseUrl: "http://localhost:11434" });
    }
  }, []);

  const fetchModels = async () => {
    try {
      const res = await fetch("/api/ollama/models");
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

  const activateModel = async (modelName: string) => {
    setError(null);
    try {
      const res = await fetch("/api/ollama/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          activeModel: modelName,
        }),
      });
      if (!res.ok) throw new Error("Failed to save config");
      onProviderChange("ollama", modelName);
    } catch {
      setError("Failed to activate model");
    }
  };

  const deactivate = async () => {
    setError(null);
    try {
      await fetch("/api/ollama/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false, activeModel: "" }),
      });
      onProviderChange("ollama", "");
    } catch {
      setError("Failed to deactivate");
    }
  };

  const pullModel = async (modelName: string) => {
    setError(null);
    setPulling(modelName);
    setPullProgress(0);
    setPullStatus("Starting download...");

    try {
      const res = await fetch("/api/ollama/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      });

      if (!res.ok) {
        throw new Error("Failed to start pull");
      }

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
            setPullStatus(msg.status ?? "");
            if (msg.total && msg.completed) {
              setPullProgress(Math.round((msg.completed / msg.total) * 100));
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Refresh model list after pull
      await fetchModels();
    } catch {
      setError(`Failed to pull ${modelName}`);
    } finally {
      setPulling(null);
      setPullProgress(0);
      setPullStatus("");
    }
  };

  const deleteModel = async (modelName: string) => {
    setError(null);
    try {
      const res = await fetch("/api/ollama/models", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      });
      if (!res.ok) throw new Error("Failed to delete");
      setModels((prev) => prev.filter((m) => m.name !== modelName));
      if (activeModel === modelName) {
        deactivate();
      }
    } catch {
      setError(`Failed to delete ${modelName}`);
    }
  };

  const installedNames = new Set(models.map((m) => m.name));
  const recommendedNotInstalled = RECOMMENDED_OLLAMA_MODELS.filter(
    (r) => !installedNames.has(r.id)
  );

  // State 1: Not detected / loading
  if (!status) {
    return <div className="text-xs text-t-tertiary">Checking Ollama...</div>;
  }

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
              Ollama is the active provider but is not reachable.
            </p>
            <p className="text-t-secondary mb-2">
              Queries will fail until Ollama is restarted or you switch back to a cloud provider.
            </p>
            <button
              onClick={deactivate}
              className="px-2.5 py-1 text-xs font-medium border border-error-text text-error-text hover:bg-error-text hover:text-white transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Deactivate Ollama
            </button>
          </div>
        )}

        {error && <p className="mb-2 text-xs text-error-text">{error}</p>}

        <button
          onClick={() => setShowSetup((s) => !s)}
          className="text-xs text-accent hover:text-accent-hover transition-colors mb-2"
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          {showSetup ? "Hide setup guide" : "Setup guide"}
        </button>

        {showSetup && (
          <div
            className="mb-3 p-2.5 text-xs text-t-secondary bg-surface-input border border-border-default space-y-2"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            <p className="font-medium text-t-primary">Install Ollama:</p>
            <div>
              <p className="text-t-tertiary">macOS:</p>
              <code
                className="block mt-0.5 px-1.5 py-1 bg-surface-card text-[11px] font-mono"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                brew install ollama && ollama serve
              </code>
            </div>
            <div>
              <p className="text-t-tertiary">Linux:</p>
              <code
                className="block mt-0.5 px-1.5 py-1 bg-surface-card text-[11px] font-mono"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                curl -fsSL https://ollama.ai/install.sh | sh
              </code>
            </div>
            <div>
              <p className="text-t-tertiary">Windows:</p>
              <p className="mt-0.5">
                Download from{" "}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:text-accent-hover underline"
                >
                  ollama.com
                </a>
              </p>
            </div>
          </div>
        )}

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
    );
  }

  // State 2 & 3: Running
  return (
    <div>
      {/* Status bar */}
      <div className="flex items-center gap-2 mb-3">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span className="text-xs font-medium text-t-secondary">v{status.version}</span>
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
            <select
              value={activeModel}
              onChange={(e) => activateModel(e.target.value)}
              className="flex-1 border border-border-default bg-surface-input px-2 py-1.5 text-sm text-t-primary"
              style={{ borderRadius: "var(--radius-badge)" }}
            >
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} ({formatSize(m.size)})
                </option>
              ))}
            </select>
            <button
              onClick={deactivate}
              className="px-2 py-1.5 text-xs border border-border-default text-t-secondary hover:text-error-text hover:border-error-text transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
              title="Deactivate Ollama"
            >
              Off
            </button>
          </div>
        </div>
      )}

      {/* Installed models */}
      {models.length > 0 && !(isActive && activeModel) && (
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-t-secondary">
            Installed Models
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
                  <span className="text-[11px] text-t-tertiary">{formatSize(m.size)}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => activateModel(m.name)}
                    className="px-2 py-0.5 text-[11px] font-medium bg-accent-subtle text-accent-text hover:bg-accent hover:text-white transition-colors"
                    style={{
                      borderRadius: "var(--radius-badge)",
                      transitionDuration: "var(--transition-speed)",
                    }}
                  >
                    Activate
                  </button>
                  <button
                    onClick={() => deleteModel(m.name)}
                    className="px-1.5 py-0.5 text-[11px] text-t-tertiary hover:text-error-text transition-colors"
                    style={{ transitionDuration: "var(--transition-speed)" }}
                    title="Delete model"
                  >
                    &times;
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pull progress */}
      {pulling && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-t-secondary">Pulling {pulling}...</span>
            <span className="text-xs text-t-tertiary">{pullProgress}%</span>
          </div>
          <div
            className="h-1.5 w-full bg-surface-input overflow-hidden"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            <div
              className="h-full bg-accent transition-all"
              style={{
                width: `${pullProgress}%`,
                transitionDuration: "var(--transition-speed)",
              }}
            />
          </div>
          <p className="mt-1 text-[11px] text-t-tertiary truncate">{pullStatus}</p>
        </div>
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
                  <span className="text-xs font-medium text-t-primary truncate block">{r.id}</span>
                  <span className="text-[11px] text-t-tertiary">{r.description}</span>
                </div>
                <button
                  onClick={() => pullModel(r.id)}
                  className="shrink-0 px-2 py-0.5 text-[11px] font-medium border border-accent text-accent hover:bg-accent hover:text-white transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  Pull
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Custom pull input */}
      {!pulling && (
        <div>
          <label className="mb-1 block text-xs font-medium text-t-secondary">
            Pull Custom Model
          </label>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. mistral:7b or hf.co/user/repo"
              className="flex-1 border border-border-default bg-surface-input px-2 py-1.5 text-xs text-t-primary placeholder:text-t-tertiary"
              style={{ borderRadius: "var(--radius-badge)" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customModel.trim()) {
                  pullModel(customModel.trim());
                  setCustomModel("");
                }
              }}
            />
            <button
              onClick={() => {
                if (customModel.trim()) {
                  pullModel(customModel.trim());
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
              Pull
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

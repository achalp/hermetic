"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  RECOMMENDED_MLX_MODELS,
  RECOMMENDED_LLAMACPP_MODELS,
  RECOMMENDED_OLLAMA_MODELS,
} from "@/lib/constants";
import type { LocalBackendId, RecommendedModel } from "@/lib/constants";

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

const RECOMMENDED_MODELS: Record<LocalBackendId, readonly RecommendedModel[]> = {
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
    systemRamGb?: number;
  } | null>(null);
  const [models, setModels] = useState<BackendModel[]>([]);
  const [pulling, setPulling] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState(0);
  const [pullStatus, setPullStatus] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startProgress, setStartProgress] = useState<number | null>(null);
  const [startLogs, setStartLogs] = useState<string[]>([]);
  const [showOversized, setShowOversized] = useState(false);
  const statusChecked = useRef(false);

  const label = BACKEND_LABELS[backend];

  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch(`/api/local-llm/models?backend=${backend}`);
      if (res.ok) {
        const data = await res.json();
        setModels(data.models ?? []);
      }
    } catch {
      // ignore
    }
  }, [backend]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/local-llm/status?backend=${backend}`);
      const data = await res.json();
      setStatus(data);
      // Always fetch models (managed backends can list cached models even when off)
      fetchModels();
    } catch {
      setStatus({ running: false });
    }
  }, [backend, fetchModels]);

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
      // For MLX/llama.cpp, switching models requires restarting the server
      // since the model is loaded at startup. Ollama loads models on demand.
      if (backend !== "ollama" && status?.running) {
        await startServer(modelName);
        return;
      }
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

  const [startingStatus, setStartingStatus] = useState<string | null>(null);

  const startServer = async (modelName: string) => {
    setError(null);
    setStarting(true);
    setStartingStatus("Launching server...");
    setStartProgress(null);
    setStartLogs([]);
    try {
      const res = await fetch("/api/local-llm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          backend,
          model: modelName || (backend === "ollama" ? "default" : recommended[0]?.id || "default"),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start server");

      // Poll status until ready (model loading can take minutes for MLX/llama.cpp)
      setStartingStatus("Waiting for server...");
      const maxWaitMs = 5 * 60_000; // 5 minutes
      const start = Date.now();
      while (Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, 2000));
        const statusRes = await fetch(`/api/local-llm/status?backend=${backend}`);
        const statusData = await statusRes.json();

        if (statusData.status === "ready") {
          await checkStatus();
          if (modelName) {
            await activateModel(modelName);
          }
          setStartingStatus(null);
          return;
        }

        if (statusData.status === "stopped") {
          const rawLogs: string[] = statusData.logs?.slice(-10) ?? [];
          const cleanLogs = rawLogs.map((l: string) => l.replace(/^\[(stdout|stderr)\]\s*/, ""));
          const logText = cleanLogs.join("\n");

          // Detect memory/GPU crash patterns
          const isMemoryCrash =
            /metal|gpu|check_error|SIGABRT|abort|command buffer|out of memory|jetsam/i.test(
              logText
            );

          const hint = isMemoryCrash
            ? "The model is too large for your available memory. Try a smaller model."
            : "Check logs below for details.";

          const logTail = cleanLogs.length > 0 ? "\n" + cleanLogs.slice(-5).join("\n") : "";
          throw new Error(`Server crashed. ${hint}${logTail}`);
        }

        // Still starting — parse logs for download progress and status
        if (statusData.logs?.length) {
          const cleaned: string[] = statusData.logs
            .slice(-10)
            .map((l: string) => l.replace(/^\[(stdout|stderr)\]\s*/, ""));
          setStartLogs(cleaned);

          // Look for percentage patterns in logs (HuggingFace downloads, etc.)
          // Patterns: "45%|", "Downloading: 45%", "XX/YY bytes", percentage in progress bars
          let pct: number | null = null;
          for (let i = cleaned.length - 1; i >= 0; i--) {
            const line = cleaned[i];
            // Match "XX%" pattern (e.g., "45%|████" or "Downloading: 72%")
            const pctMatch = line.match(/(\d{1,3})%/);
            if (pctMatch) {
              pct = parseInt(pctMatch[1], 10);
              break;
            }
          }
          setStartProgress(pct);

          // Use last meaningful line as status text
          const lastLine = cleaned[cleaned.length - 1]?.slice(0, 120) ?? "";
          if (pct !== null) {
            setStartingStatus(`Downloading model... ${pct}%`);
          } else if (lastLine) {
            setStartingStatus(`Starting... ${lastLine.slice(0, 80)}`);
          }
        }
      }

      throw new Error("Server did not become ready within 5 minutes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start server");
      setStartingStatus(null);
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
      let finished = false;

      while (!finished) {
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
            if (msg.done || msg.error) {
              finished = true;
              if (msg.error) throw new Error(msg.status || "Download failed");
              break;
            }
          } catch (e) {
            if (e instanceof Error && e.message !== "Download failed") continue;
            throw e;
          }
        }
      }

      reader.cancel();
      await fetchModels();
    } catch {
      setError(`Failed to download ${modelName}`);
    } finally {
      setPulling(null);
      setPullProgress(0);
      setPullStatus("");
    }
  };

  const deleteModel = async (modelName: string) => {
    if (
      !confirm(
        `Delete ${modelName}? This will free disk space but the model will need to be re-downloaded to use again.`
      )
    ) {
      return;
    }
    setError(null);
    try {
      const res = await fetch("/api/local-llm/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend, model: modelName }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete model");
      }
      await fetchModels();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete model");
    }
  };

  const allRecommended = RECOMMENDED_MODELS[backend] ?? [];
  const systemRam = status?.systemRamGb ?? 0;
  // Filter by RAM — show models that fit, plus all if RAM is unknown (0)
  const recommended =
    systemRam > 0 ? allRecommended.filter((r) => r.minRam <= systemRam) : allRecommended;
  const oversized = systemRam > 0 ? allRecommended.filter((r) => r.minRam > systemRam) : [];
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
          {systemRam > 0 && (
            <span className="ml-auto text-[11px] text-t-tertiary">{systemRam} GB RAM</span>
          )}
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

        {error && (
          <pre className="mb-2 text-xs text-error-text whitespace-pre-wrap break-words">
            {error}
          </pre>
        )}

        {/* Start Server button — always visible for all backends when not running */}
        {!starting && !pulling && (
          <div className="mb-3">
            <button
              onClick={() => startServer(models[0]?.name ?? recommended[0]?.id ?? "")}
              disabled={starting}
              className="px-3 py-1.5 text-xs font-medium bg-accent-subtle text-accent-text hover:bg-accent hover:text-white disabled:opacity-40 transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Start {label}
            </button>
          </div>
        )}

        {/* Downloaded models — pick which model to start with (MLX / llama.cpp) */}
        {backend !== "ollama" && models.length > 0 && !pulling && !starting && (
          <div className="mb-3">
            <label className="mb-1.5 block text-xs font-medium text-t-secondary">
              Downloaded Models
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
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startServer(m.name)}
                      disabled={starting}
                      className="px-2 py-0.5 text-[11px] font-medium bg-accent-subtle text-accent-text hover:bg-accent hover:text-white disabled:opacity-40 transition-colors"
                      style={{
                        borderRadius: "var(--radius-badge)",
                        transitionDuration: "var(--transition-speed)",
                      }}
                    >
                      Start
                    </button>
                    <button
                      onClick={() => deleteModel(m.name)}
                      className="px-1.5 py-0.5 text-[11px] font-medium text-t-tertiary hover:text-error-text transition-colors"
                      style={{
                        borderRadius: "var(--radius-badge)",
                        transitionDuration: "var(--transition-speed)",
                      }}
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

        {/* Download progress */}
        {pulling && (
          <DownloadProgress pulling={pulling} progress={pullProgress} status={pullStatus} />
        )}

        {/* Starting status with download progress */}
        {starting && startingStatus && (
          <div className="mb-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-yellow-500 animate-pulse" />
                <span className="text-xs font-medium text-t-secondary">
                  {startProgress !== null
                    ? `Downloading model... ${startProgress}%`
                    : "Starting..."}
                </span>
              </div>
              {startProgress !== null && (
                <span className="text-xs text-t-tertiary">{startProgress}%</span>
              )}
            </div>
            {startProgress !== null && (
              <div
                className="h-1.5 w-full bg-surface-input overflow-hidden mb-2"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                <div
                  className="h-full bg-accent transition-all"
                  style={{
                    width: `${startProgress}%`,
                    transitionDuration: "var(--transition-speed)",
                  }}
                />
              </div>
            )}
            {startLogs.length > 0 && (
              <div
                className="p-2 bg-surface-input text-[11px] text-t-tertiary font-mono max-h-24 overflow-y-auto"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {startLogs.slice(-5).map((line, i) => (
                  <div key={i} className="truncate">
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Recommended models to download — skip Ollama (requires running server to pull) */}
        {backend !== "ollama" && recommendedNotInstalled.length > 0 && !pulling && !starting && (
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

        {/* Oversized models — collapsed, with warning */}
        {backend !== "ollama" && oversized.length > 0 && !pulling && !starting && (
          <div className="mb-3">
            <button
              onClick={() => setShowOversized((v) => !v)}
              className="mb-1.5 flex items-center gap-1 text-xs font-medium text-t-tertiary hover:text-t-secondary transition-colors"
            >
              <span className="text-[11px]">{showOversized ? "▼" : "▶"}</span>
              Larger models (need more than {systemRam} GB)
            </button>
            {showOversized && (
              <div className="space-y-1 opacity-60">
                {oversized
                  .filter((r) => !installedNames.has(r.id))
                  .map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 border border-border-default"
                      style={{ borderRadius: "var(--radius-badge)" }}
                    >
                      <div className="min-w-0">
                        <span className="text-xs font-medium text-t-primary truncate block">
                          {r.label || r.id}
                          <span className="ml-1 text-[10px] text-t-tertiary font-normal">
                            ({r.minRam}+ GB)
                          </span>
                        </span>
                        <span className="text-[11px] text-t-tertiary">{r.description}</span>
                      </div>
                      <button
                        onClick={() => downloadModel(r.id)}
                        className="shrink-0 px-2 py-0.5 text-[11px] font-medium border border-border-default text-t-tertiary hover:text-t-primary transition-colors"
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
            )}
          </div>
        )}

        {/* Custom model download — skip Ollama when not running */}
        {backend !== "ollama" && !pulling && !starting && (
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-t-secondary">
              Download Custom Model
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder={
                  backend === "mlx"
                    ? "e.g. mlx-community/Qwen2.5-Coder-14B-Instruct-4bit"
                    : "e.g. bartowski/Qwen2.5-Coder-14B-Instruct-GGUF"
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
        <button
          onClick={stopServer}
          disabled={stopping}
          className="ml-auto px-2 py-0.5 text-[11px] font-medium border border-border-default text-t-secondary hover:text-error-text hover:border-error-text transition-colors"
          style={{
            borderRadius: "var(--radius-badge)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          {stopping ? "..." : "Stop"}
        </button>
      </div>

      {error && (
        <pre className="mb-2 text-xs text-error-text whitespace-pre-wrap break-words">{error}</pre>
      )}

      {/* Downloaded models list — always visible */}
      {models.length > 0 && (
        <div className="mb-3">
          <label className="mb-1.5 block text-xs font-medium text-t-secondary">
            Downloaded Models
          </label>
          <div className="space-y-1">
            {models.map((m) => {
              const isCurrentActive = isActive && activeModel === m.name;
              return (
                <div
                  key={m.name}
                  className={`flex items-center justify-between gap-2 px-2 py-1.5 border ${isCurrentActive ? "border-accent bg-accent-subtle/30" : "border-border-default"}`}
                  style={{ borderRadius: "var(--radius-badge)" }}
                >
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-t-primary truncate block">
                      {m.name}
                      {isCurrentActive && <span className="text-accent-text ml-1">(active)</span>}
                    </span>
                    {formatSize(m.size) && (
                      <span className="text-[11px] text-t-tertiary">{formatSize(m.size)}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!isCurrentActive && (
                      <button
                        onClick={() => activateModel(m.name)}
                        disabled={starting}
                        className="px-2 py-0.5 text-[11px] font-medium bg-accent-subtle text-accent-text hover:bg-accent hover:text-white disabled:opacity-40 transition-colors"
                        style={{
                          borderRadius: "var(--radius-badge)",
                          transitionDuration: "var(--transition-speed)",
                        }}
                      >
                        Activate
                      </button>
                    )}
                    <button
                      onClick={() => deleteModel(m.name)}
                      className="px-1.5 py-0.5 text-[11px] font-medium text-t-tertiary hover:text-error-text transition-colors"
                      style={{
                        borderRadius: "var(--radius-badge)",
                        transitionDuration: "var(--transition-speed)",
                      }}
                      title="Delete model"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              );
            })}
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

      {/* Oversized models — collapsed, with warning (running state) */}
      {oversized.length > 0 && !pulling && (
        <div className="mb-3">
          <button
            onClick={() => setShowOversized((v) => !v)}
            className="mb-1.5 flex items-center gap-1 text-xs font-medium text-t-tertiary hover:text-t-secondary transition-colors"
          >
            <span className="text-[11px]">{showOversized ? "▼" : "▶"}</span>
            Larger models (need more than {systemRam} GB)
          </button>
          {showOversized && (
            <div className="space-y-1 opacity-60">
              {oversized
                .filter((r) => !installedNames.has(r.id))
                .map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 border border-border-default"
                    style={{ borderRadius: "var(--radius-badge)" }}
                  >
                    <div className="min-w-0">
                      <span className="text-xs font-medium text-t-primary truncate block">
                        {r.label || r.id}
                        <span className="ml-1 text-[10px] text-t-tertiary font-normal">
                          ({r.minRam}+ GB)
                        </span>
                      </span>
                      <span className="text-[11px] text-t-tertiary">{r.description}</span>
                    </div>
                    <button
                      onClick={() => downloadModel(r.id)}
                      className="shrink-0 px-2 py-0.5 text-[11px] font-medium border border-border-default text-t-tertiary hover:text-t-primary transition-colors"
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
          )}
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

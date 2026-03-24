"use client";

import { useState, useEffect, useCallback } from "react";
import { AVAILABLE_MODELS, AVAILABLE_PROVIDERS } from "@/lib/constants";
import type { ModelId, SandboxRuntimeId, LLMProviderId, LocalBackendId } from "@/lib/constants";
import { LocalBackendSection } from "@/components/app/local-backend-section";
import { getProviders, getRuntimes, type ProviderInfo, type RuntimeStatus } from "@/lib/api";

interface InferenceSectionProps {
  codeGenModel: ModelId;
  uiComposeModel: ModelId;
  onCodeGenModelChange: (model: ModelId) => void;
  onUiComposeModelChange: (model: ModelId) => void;
  sandboxRuntime: SandboxRuntimeId;
  onSandboxRuntimeChange: (runtime: SandboxRuntimeId) => void;
  ollamaModel: string | null;
  onOllamaModelChange: (model: string | null) => void;
}

const S = {
  label: {
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "var(--color-surface-dark-text4)",
    marginBottom: 6,
    display: "block",
  },
  select: {
    width: "100%",
    background: "var(--color-surface-dark-2)",
    border: "1px solid var(--color-surface-dark-3)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 13,
    color: "var(--color-surface-dark-text)",
    fontFamily: "inherit",
    outline: "none",
  },
  pill: (active: boolean) => ({
    padding: "4px 10px",
    fontSize: 12,
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    fontFamily: "inherit",
    background: active ? "var(--color-accent)" : "var(--color-surface-dark-2)",
    color: active ? "#fff" : "var(--color-surface-dark-text3)",
    transition: "all 0.15s",
  }),
  mono: {
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    color: "var(--color-surface-dark-text)",
    background: "var(--color-surface-dark-2)",
    padding: "4px 10px",
    borderRadius: 4,
    display: "inline-block",
  },
  hint: { fontSize: 11, color: "var(--color-surface-dark-text4)", marginTop: 4 },
  divider: { borderTop: "1px solid var(--color-surface-dark-2)", margin: "14px 0" },
};

export function InferenceSection({
  codeGenModel,
  uiComposeModel,
  onCodeGenModelChange,
  onUiComposeModelChange,
  sandboxRuntime,
  onSandboxRuntimeChange,
  ollamaModel,
  onOllamaModelChange,
}: InferenceSectionProps) {
  // Provider info
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getProviders(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setProviderInfo(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Runtime status
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    getRuntimes(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setRuntimes(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const availableRuntimes = runtimes.filter((r) => r.available);

  useEffect(() => {
    if (availableRuntimes.length === 0) return;
    const currentIsAvailable = availableRuntimes.some((r) => r.id === sandboxRuntime);
    if (!currentIsAvailable) {
      onSandboxRuntimeChange(availableRuntimes[0].id as SandboxRuntimeId);
    }
  }, [availableRuntimes, sandboxRuntime, onSandboxRuntimeChange]);

  // Local backend tabs
  const [activeBackendTab, setActiveBackendTab] = useState<LocalBackendId>("mlx");
  const [platform, setPlatform] = useState<{ os: string; arch: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/local-llm/platform", { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => {
        if (controller.signal.aborted) return;
        setPlatform(data);
        if (!(data.os === "darwin" && data.arch === "arm64")) {
          setActiveBackendTab((prev) => (prev === "mlx" ? "llama-cpp" : prev));
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleLocalProviderChange = useCallback(
    (_provider: LocalBackendId, model: string) => {
      onOllamaModelChange(model || null);
      // Re-fetch provider info to reflect the change
      getProviders()
        .then((data) => setProviderInfo(data))
        .catch(() => {});
    },
    [onOllamaModelChange]
  );

  const isLocalActive =
    providerInfo?.active === "ollama" ||
    providerInfo?.active === "mlx" ||
    providerInfo?.active === "llama-cpp";

  const backendTabs: { id: LocalBackendId; label: string }[] = [
    ...(platform === null || (platform.os === "darwin" && platform.arch === "arm64")
      ? [{ id: "mlx" as const, label: "MLX" }]
      : []),
    { id: "llama-cpp" as const, label: "llama.cpp" },
    { id: "ollama" as const, label: "Ollama" },
  ];

  return (
    <div>
      {/* ── Provider ── */}
      <div style={S.label}>PROVIDER</div>
      <div style={{ marginBottom: 14 }}>
        {providerInfo ? (
          providerInfo.configured.length > 1 ? (
            <select
              value={providerInfo.active}
              onChange={async (e) => {
                const newProvider = e.target.value as LLMProviderId;
                try {
                  const res = await fetch("/api/providers", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider: newProvider }),
                  });
                  if (res.ok) {
                    const data = await res.json();
                    setProviderInfo({
                      ...providerInfo,
                      active: data.active,
                      activeLabel: data.activeLabel,
                    });
                  }
                } catch {
                  /* ignore */
                }
              }}
              style={S.select}
            >
              {providerInfo.configured.map((id) => {
                const info = AVAILABLE_PROVIDERS.find((p) => p.id === id);
                return (
                  <option key={id} value={id}>
                    {info?.label ?? id}
                  </option>
                );
              })}
            </select>
          ) : (
            <span style={{ ...S.mono, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--color-accent)",
                }}
              />
              {providerInfo.activeLabel}
            </span>
          )
        ) : (
          <span style={{ fontSize: 12, color: "var(--color-surface-dark-text4)" }}>
            Detecting...
          </span>
        )}
      </div>

      {/* ── Local Models ── */}
      <div style={S.label}>LOCAL MODELS</div>
      <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
        {backendTabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveBackendTab(tab.id)}
            style={{
              ...S.pill(activeBackendTab === tab.id),
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {tab.label}
            {providerInfo?.active === tab.id && (
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "#10b981",
                  display: "inline-block",
                }}
              />
            )}
          </button>
        ))}
      </div>
      <div style={{ marginBottom: 14 }}>
        <LocalBackendSection
          backend={activeBackendTab}
          onProviderChange={handleLocalProviderChange}
          isActive={providerInfo?.active === activeBackendTab}
          activeModel={providerInfo?.active === activeBackendTab ? ollamaModel : null}
        />
      </div>

      <div style={S.divider} />

      {/* ── Model Selection ── */}
      <div style={S.label}>MODELS</div>
      {isLocalActive ? (
        <div style={{ marginBottom: 14 }}>
          <span style={S.mono}>{providerInfo?.model ?? ollamaModel ?? "—"}</span>
          <div style={S.hint}>Managed via Local Models above</div>
        </div>
      ) : providerInfo?.active === "openai-compatible" ? (
        <div style={{ marginBottom: 14 }}>
          <span style={S.mono}>{providerInfo.model ?? "—"}</span>
          <div style={S.hint}>Set via OPENAI_MODEL env variable</div>
        </div>
      ) : (
        <div style={{ marginBottom: 14 }}>
          <div style={{ ...S.hint, marginBottom: 6, marginTop: 0 }}>Code Generation</div>
          <select
            value={codeGenModel}
            onChange={(e) => onCodeGenModelChange(e.target.value as ModelId)}
            style={{ ...S.select, marginBottom: 10 }}
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <div style={{ ...S.hint, marginBottom: 6, marginTop: 0 }}>UI Composition</div>
          <select
            value={uiComposeModel}
            onChange={(e) => onUiComposeModelChange(e.target.value as ModelId)}
            style={S.select}
          >
            {AVAILABLE_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={S.divider} />

      {/* ── Runtime ── */}
      <div style={S.label}>SANDBOX RUNTIME</div>
      {availableRuntimes.length === 0 ? (
        <div style={S.hint}>
          {runtimes.length > 0
            ? "No runtimes available. Start Docker or Microsandbox."
            : "Detecting..."}
        </div>
      ) : (
        <select
          value={sandboxRuntime}
          onChange={(e) => onSandboxRuntimeChange(e.target.value as SandboxRuntimeId)}
          style={S.select}
        >
          {availableRuntimes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

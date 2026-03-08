"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { AVAILABLE_MODELS } from "@/lib/constants";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import { useTheme, THEMES } from "@/lib/theme-context";
import { useClickOutside } from "@/hooks/use-click-outside";
import { OllamaSection } from "./ollama-section";
import { getProviders, getRuntimes, type ProviderInfo, type RuntimeStatus } from "@/lib/api";

interface SettingsPanelProps {
  codeGenModel: ModelId;
  uiComposeModel: ModelId;
  onCodeGenModelChange: (model: ModelId) => void;
  onUiComposeModelChange: (model: ModelId) => void;
  sandboxRuntime: SandboxRuntimeId;
  onSandboxRuntimeChange: (runtime: SandboxRuntimeId) => void;
  ollamaModel: string | null;
  onOllamaModelChange: (model: string | null) => void;
}

export function SettingsPanel({
  codeGenModel,
  uiComposeModel,
  onCodeGenModelChange,
  onUiComposeModelChange,
  sandboxRuntime,
  onSandboxRuntimeChange,
  ollamaModel,
  onOllamaModelChange,
}: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const providerFetched = useRef(false);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const runtimesFetched = useRef(false);

  useEffect(() => {
    if (providerFetched.current) return;
    providerFetched.current = true;
    getProviders()
      .then((data) => setProviderInfo(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (runtimesFetched.current) return;
    runtimesFetched.current = true;
    getRuntimes()
      .then((data) => setRuntimes(data))
      .catch(() => {});
  }, []);

  const availableRuntimes = runtimes.filter((r) => r.available);

  // Auto-switch if current runtime isn't available
  useEffect(() => {
    if (availableRuntimes.length === 0) return;
    const currentIsAvailable = availableRuntimes.some((r) => r.id === sandboxRuntime);
    if (!currentIsAvailable) {
      onSandboxRuntimeChange(availableRuntimes[0].id as SandboxRuntimeId);
    }
  }, [availableRuntimes, sandboxRuntime, onSandboxRuntimeChange]);

  const handleOllamaProviderChange = useCallback(
    (_provider: "ollama", model: string) => {
      onOllamaModelChange(model || null);
      // Re-fetch provider info to reflect the change
      providerFetched.current = false;
      getProviders()
        .then((data) => setProviderInfo(data))
        .catch(() => {});
    },
    [onOllamaModelChange]
  );

  const isOllamaActive = providerInfo?.active === "ollama";

  const closePanel = useCallback(() => setOpen(false), []);
  useClickOutside(panelRef, closePanel, open);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`p-1.5 transition-colors text-t-secondary hover:text-t-primary`}
        style={{
          borderRadius: "var(--radius-badge)",
          transitionDuration: "var(--transition-speed)",
        }}
        title="Settings"
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
          />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full z-50 mt-2 w-80 max-h-[80vh] overflow-y-auto border border-border-default bg-surface-dropdown p-4"
          style={{
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-elevated)",
            backdropFilter: "var(--backdrop-card)",
            WebkitBackdropFilter: "var(--backdrop-card)",
          }}
        >
          {/* Theme selector */}
          <h3 className="mb-3 text-sm font-semibold text-t-primary">Theme</h3>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                className={`flex flex-col items-start px-3 py-2 text-left text-xs transition-colors ${
                  theme === t.id
                    ? "bg-accent-subtle text-accent-text font-medium"
                    : "text-t-secondary hover:bg-surface-btn"
                }`}
                style={{
                  borderRadius: "var(--radius-badge)",
                  border:
                    theme === t.id
                      ? "1px solid var(--color-accent)"
                      : "1px solid var(--color-border-default)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                <span className="font-medium">{t.label}</span>
                <span className={theme === t.id ? "opacity-70" : "text-t-tertiary"}>
                  {t.description}
                </span>
              </button>
            ))}
          </div>

          <div className="mb-3 border-t border-border-default pt-3">
            <h3 className="mb-3 text-sm font-semibold text-t-primary">LLM Provider</h3>
          </div>

          <div className="mb-4">
            {providerInfo ? (
              <span
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-accent-subtle text-accent-text"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
                {providerInfo.activeLabel}
              </span>
            ) : (
              <span className="text-xs text-t-tertiary">Detecting...</span>
            )}
            {!isOllamaActive && (
              <p className="mt-1.5 text-xs text-t-tertiary">Set via server environment variables</p>
            )}
          </div>

          <div className="mb-3 border-t border-border-default pt-3">
            <h3 className="mb-3 text-sm font-semibold text-t-primary">Local Models (Ollama)</h3>
          </div>

          <div className="mb-4">
            <OllamaSection
              onProviderChange={handleOllamaProviderChange}
              isActive={isOllamaActive}
              activeModel={ollamaModel}
            />
          </div>

          <div className="mb-3 border-t border-border-default pt-3">
            <h3 className="mb-3 text-sm font-semibold text-t-primary">Model Settings</h3>
          </div>

          {isOllamaActive ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-t-secondary">Model</label>
              <span
                className="inline-flex items-center px-2.5 py-1.5 text-sm font-mono text-t-primary bg-surface-input border border-border-default"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {ollamaModel ?? "—"}
              </span>
              <p className="mt-1.5 text-xs text-t-tertiary">Managed via Ollama section above</p>
            </div>
          ) : providerInfo?.active === "openai-compatible" ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-t-secondary">Model</label>
              <span
                className="inline-flex items-center px-2.5 py-1.5 text-sm font-mono text-t-primary bg-surface-input border border-border-default"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {providerInfo.model ?? "—"}
              </span>
              <p className="mt-1.5 text-xs text-t-tertiary">
                Set via OPENAI_MODEL environment variable
              </p>
            </div>
          ) : (
            <>
              <label className="mb-1 block text-xs font-medium text-t-secondary">
                Code Generation
              </label>
              <select
                value={codeGenModel}
                onChange={(e) => onCodeGenModelChange(e.target.value as ModelId)}
                className="mb-3 w-full border border-border-default bg-surface-input px-2 py-1.5 text-sm text-t-primary"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {AVAILABLE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>

              <label className="mb-1 block text-xs font-medium text-t-secondary">
                UI Composition
              </label>
              <select
                value={uiComposeModel}
                onChange={(e) => onUiComposeModelChange(e.target.value as ModelId)}
                className="w-full border border-border-default bg-surface-input px-2 py-1.5 text-sm text-t-primary"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {AVAILABLE_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </>
          )}

          <div className="mb-3 mt-4 border-t border-border-default pt-3">
            <h3 className="mb-3 text-sm font-semibold text-t-primary">Sandbox Runtime</h3>
          </div>

          <label className="mb-1 block text-xs font-medium text-t-secondary">Code Execution</label>
          {availableRuntimes.length === 0 ? (
            <p className="text-xs text-t-tertiary">Detecting runtimes...</p>
          ) : (
            <select
              value={sandboxRuntime}
              onChange={(e) => onSandboxRuntimeChange(e.target.value as SandboxRuntimeId)}
              className="w-full border border-border-default bg-surface-input px-2 py-1.5 text-sm text-t-primary"
              style={{ borderRadius: "var(--radius-badge)" }}
            >
              {availableRuntimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
          {runtimes.length > 0 && availableRuntimes.length === 0 && (
            <p className="mt-1 text-xs text-error-text">
              No runtimes available. Start Docker or Microsandbox.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

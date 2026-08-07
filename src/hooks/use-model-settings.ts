"use client";

/**
 * Model / runtime / local-backend selections for the page (extracted from
 * page.tsx, exit audit F1). Choices persist to localStorage so they survive a
 * restart — the value is sent with every query, so client-side is enough.
 * Previously the change handlers only called setState → reverted to the
 * default constant on reload.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  STORAGE_KEYS,
  isValidRuntimeId,
  isValidModelId,
} from "@/lib/constants";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import { getLocalBackendConfig, setActiveSandboxRuntime, setActiveModels } from "@/app/lib/api";

export function useModelSettings() {
  const [codeGenModel, setCodeGenModel] = useState<ModelId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEYS.codeGenModel);
      if (stored && isValidModelId(stored)) return stored;
    }
    return CODE_GEN_MODEL;
  });
  const [uiComposeModel, setUiComposeModel] = useState<ModelId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEYS.uiComposeModel);
      if (stored && isValidModelId(stored)) return stored;
    }
    return UI_COMPOSE_MODEL;
  });
  const [sandboxRuntime, setSandboxRuntime] = useState<SandboxRuntimeId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEYS.sandboxRuntime);
      if (stored && isValidRuntimeId(stored)) return stored;
    }
    return DEFAULT_SANDBOX_RUNTIME;
  });
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);

  // Adopt the server-side model selection when one is stored — runtime-config
  // is the cross-harness source of truth (MCP reads it too), so a choice made
  // in another browser/profile still wins over this tab's stale localStorage.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { config?: { models?: { codeGen?: string; uiCompose?: string } } } | null) => {
        const m = data?.config?.models;
        if (m?.codeGen && isValidModelId(m.codeGen)) {
          setCodeGenModel(m.codeGen);
          localStorage.setItem(STORAGE_KEYS.codeGenModel, m.codeGen);
        }
        if (m?.uiCompose && isValidModelId(m.uiCompose)) {
          setUiComposeModel(m.uiCompose);
          localStorage.setItem(STORAGE_KEYS.uiComposeModel, m.uiCompose);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  // Reflect the server-side local-backend config (whichever backend is
  // enabled with an active model) into the settings drawer's model field.
  useEffect(() => {
    const controller = new AbortController();
    getLocalBackendConfig(controller.signal)
      .then((data) => {
        const active =
          data.mlx?.enabled && data.mlx?.activeModel
            ? data.mlx.activeModel
            : data.llamaCpp?.enabled && data.llamaCpp?.activeModel
              ? data.llamaCpp.activeModel
              : data.ollama?.enabled && data.ollama?.activeModel
                ? data.ollama.activeModel
                : null;
        if (active) setOllamaModel(active);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleRuntimeChange = useCallback((r: SandboxRuntimeId) => {
    setSandboxRuntime(r);
    localStorage.setItem(STORAGE_KEYS.sandboxRuntime, r);
    setActiveSandboxRuntime(r).catch(() => {});
  }, []);

  // Model choices persist BOTH client-side (localStorage — instant reload
  // state) and server-side (runtime-config via /api/settings) so the MCP
  // server and requests that send no explicit model honor the same choice.
  const handleCodeGenModelChange = useCallback((m: ModelId) => {
    setCodeGenModel(m);
    localStorage.setItem(STORAGE_KEYS.codeGenModel, m);
    setActiveModels({ codeGen: m }).catch(() => {});
  }, []);
  const handleUiComposeModelChange = useCallback((m: ModelId) => {
    setUiComposeModel(m);
    localStorage.setItem(STORAGE_KEYS.uiComposeModel, m);
    setActiveModels({ uiCompose: m }).catch(() => {});
  }, []);

  return {
    codeGenModel,
    uiComposeModel,
    sandboxRuntime,
    ollamaModel,
    setOllamaModel,
    handleRuntimeChange,
    handleCodeGenModelChange,
    handleUiComposeModelChange,
  };
}

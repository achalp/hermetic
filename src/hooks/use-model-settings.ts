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
import { getLocalBackendConfig, setActiveSandboxRuntime } from "@/lib/api";

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

  const handleCodeGenModelChange = useCallback((m: ModelId) => {
    setCodeGenModel(m);
    localStorage.setItem(STORAGE_KEYS.codeGenModel, m);
  }, []);
  const handleUiComposeModelChange = useCallback((m: ModelId) => {
    setUiComposeModel(m);
    localStorage.setItem(STORAGE_KEYS.uiComposeModel, m);
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

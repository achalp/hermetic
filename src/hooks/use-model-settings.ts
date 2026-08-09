"use client";

/**
 * Model / runtime / local-backend selections for the page (extracted from
 * page.tsx, exit audit F1).
 *
 * GOLDEN SOURCE: runtime-config.json, via /api/settings. This hook is a
 * MIRROR of the server-side selection, never a second store — the previous
 * localStorage copy was sent with every request and forked the web onto a
 * different model than MCP whenever the server-side value was lost (the
 * settings PUT once clobbered it on every efforts-only save). State here
 * initializes from the server's EFFECTIVE selection on mount and PUTs
 * changes back; requests carry no model/runtime fields at all (the server
 * resolves from runtime-config for every harness).
 */
import { useCallback, useEffect, useState } from "react";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  isValidRuntimeId,
  isValidModelId,
} from "@/lib/constants";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import {
  getLocalBackendConfig,
  setActiveSandboxRuntime,
  setActiveModels,
  setComposerMode as setComposerModeApi,
} from "@/app/lib/api";

export function useModelSettings() {
  const [codeGenModel, setCodeGenModel] = useState<ModelId>(CODE_GEN_MODEL);
  const [uiComposeModel, setUiComposeModel] = useState<ModelId>(UI_COMPOSE_MODEL);
  const [sandboxRuntime, setSandboxRuntime] = useState<SandboxRuntimeId>(DEFAULT_SANDBOX_RUNTIME);
  // Reasoning-effort override ("auto" = phase-routed defaults). Server-side
  // in runtime-config like everything else here.
  const [effort, setEffort] = useState<string>("auto");
  const [phaseEfforts, setPhaseEfforts] = useState<Record<string, string>>({});
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);
  // Composer architecture (narrative-compiler spec): generative | compiled.
  const [composerMode, setComposerMode] = useState<"generative" | "compiled">("generative");

  // Adopt the server-side EFFECTIVE selection on mount — the resolved values
  // (stored choice or default), same ones every run will use.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/settings", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          data: {
            config?: { models?: { effort?: string; efforts?: Record<string, string> } };
            effective?: {
              models?: { codeGen?: string; uiCompose?: string };
              sandbox?: { runtime?: string };
            };
          } | null
        ) => {
          const m = data?.effective?.models;
          if (m?.codeGen && isValidModelId(m.codeGen)) setCodeGenModel(m.codeGen);
          if (m?.uiCompose && isValidModelId(m.uiCompose)) setUiComposeModel(m.uiCompose);
          const rt = data?.effective?.sandbox?.runtime;
          if (rt && isValidRuntimeId(rt)) setSandboxRuntime(rt);
          const cfg = data?.config?.models;
          if (cfg?.effort) setEffort(cfg.effort);
          if (cfg?.efforts && typeof cfg.efforts === "object") setPhaseEfforts(cfg.efforts);
          const cm = (data?.config as { composer?: { mode?: string } } | undefined)?.composer?.mode;
          if (cm === "compiled" || cm === "generative") setComposerMode(cm);
        }
      )
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

  // Every change persists to the golden source; local state is the
  // optimistic mirror for the UI.
  const handleRuntimeChange = useCallback((r: SandboxRuntimeId) => {
    setSandboxRuntime(r);
    setActiveSandboxRuntime(r).catch(() => {});
  }, []);
  const handleCodeGenModelChange = useCallback((m: ModelId) => {
    setCodeGenModel(m);
    setActiveModels({ codeGen: m }).catch(() => {});
  }, []);
  const handleEffortChange = useCallback((e: string) => {
    setEffort(e);
    setActiveModels({ effort: e }).catch(() => {});
  }, []);
  const handlePhaseEffortChange = useCallback((phase: string, level: string) => {
    setPhaseEfforts((prev) => {
      const next = { ...prev };
      if (level === "auto") delete next[phase];
      else next[phase] = level;
      setActiveModels({ efforts: next }).catch(() => {});
      return next;
    });
  }, []);
  const handleComposerModeChange = useCallback((m: "generative" | "compiled") => {
    setComposerMode(m);
    setComposerModeApi(m).catch(() => {});
  }, []);
  const handleUiComposeModelChange = useCallback((m: ModelId) => {
    setUiComposeModel(m);
    setActiveModels({ uiCompose: m }).catch(() => {});
  }, []);

  return {
    codeGenModel,
    uiComposeModel,
    sandboxRuntime,
    composerMode,
    handleComposerModeChange,
    ollamaModel,
    setOllamaModel,
    handleRuntimeChange,
    handleCodeGenModelChange,
    handleUiComposeModelChange,
    effort,
    handleEffortChange,
    phaseEfforts,
    handlePhaseEffortChange,
  };
}

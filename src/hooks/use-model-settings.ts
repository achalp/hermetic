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
import { PROFILE_DEPTHS, DEFAULT_PROFILE_DEPTH, type ProfileDepth } from "@/lib/constants";
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
  getModelSettings,
  setActiveSandboxRuntime,
  setActiveModels,
  setComposerMode as setComposerModeApi,
  setProfileDepth as setProfileDepthApi,
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
  // Rows a FILE-source value profile examines (warehouses have no value stats).
  const [profileDepth, setProfileDepth] = useState<ProfileDepth>(DEFAULT_PROFILE_DEPTH);
  // Composer architecture (narrative-compiler spec): generative | compiled.
  const [composerMode, setComposerMode] = useState<"generative" | "compiled">("generative");
  // Surfaced when a settings write did NOT land (the old behavior silently
  // reverted the optimistic mirror, so a runtime pick that never persisted
  // looked identical to one that did — the "I set wasm, it went back to
  // docker" report). Cleared on the next successful change or adopt.
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  // Adopt the server-side EFFECTIVE selection — the resolved values (stored
  // choice or default), same ones every run will use. Runs on mount, and
  // again after any FAILED write: the optimistic mirror must snap back to
  // server truth instead of displaying a selection that was never persisted
  // (a "Compiled" pick made while the server was restarting kept showing
  // Compiled until the next reload revealed it had silently never landed).
  const adoptServerSettings = useCallback((signal?: AbortSignal) => {
    return getModelSettings(signal)
      .then((data) => {
        if (!data) return;
        const m = data.effective?.models;
        if (m?.codeGen && isValidModelId(m.codeGen)) setCodeGenModel(m.codeGen);
        if (m?.uiCompose && isValidModelId(m.uiCompose)) setUiComposeModel(m.uiCompose);
        const rt = data.effective?.sandbox?.runtime;
        if (rt && isValidRuntimeId(rt)) setSandboxRuntime(rt);
        setSettingsNotice(null);
        const cfg = data.config?.models;
        setEffort(cfg?.effort ?? "auto");
        setPhaseEfforts(cfg?.efforts && typeof cfg.efforts === "object" ? cfg.efforts : {});
        const pd = data.effective?.sandbox?.profileDepth;
        if (PROFILE_DEPTHS.includes(pd as ProfileDepth)) setProfileDepth(pd as ProfileDepth);
        const cm = data.config?.composer?.mode;
        setComposerMode(cm === "compiled" ? "compiled" : "generative");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void adoptServerSettings(controller.signal);
    return () => controller.abort();
  }, [adoptServerSettings]);

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
  // optimistic mirror for the UI. A FAILED write re-adopts server truth —
  // an optimistic value that never landed must not keep displaying as if
  // it had (the silent-lie window behind "my setting flipped back").
  const revert = useCallback(() => void adoptServerSettings(), [adoptServerSettings]);
  const handleRuntimeChange = useCallback(
    (r: SandboxRuntimeId) => {
      setSandboxRuntime(r); // optimistic mirror
      setSettingsNotice(null);
      setActiveSandboxRuntime(r)
        .then(() => {
          // Confirm the server side effect MATCHES the intent — re-read the
          // effective selection rather than trusting the optimistic value, so
          // a concurrent write (or a server-side coercion) can't leave the UI
          // asserting a runtime that isn't the one a run will actually use.
          return getModelSettings().then((data) => {
            const eff = data?.effective?.sandbox?.runtime;
            if (eff && isValidRuntimeId(eff)) {
              setSandboxRuntime(eff);
              if (eff !== r) {
                setSettingsNotice(
                  `Runtime is "${eff}", not "${r}" — the server did not keep your choice.`
                );
              }
            }
          });
        })
        .catch(async () => {
          // The write itself failed: snap back to server truth AND say so,
          // never a silent revert. Adopt FIRST (it clears the notice on
          // success), THEN set the failure notice so it survives.
          await adoptServerSettings();
          setSettingsNotice(`Couldn't switch runtime to "${r}" — reverted to the saved setting.`);
        });
    },
    [adoptServerSettings]
  );
  const handleCodeGenModelChange = useCallback(
    (m: ModelId) => {
      setCodeGenModel(m);
      setActiveModels({ codeGen: m }).catch(revert);
    },
    [revert]
  );
  const handleEffortChange = useCallback(
    (e: string) => {
      setEffort(e);
      setActiveModels({ effort: e }).catch(revert);
    },
    [revert]
  );
  const handlePhaseEffortChange = useCallback(
    (phase: string, level: string) => {
      setPhaseEfforts((prev) => {
        const next = { ...prev };
        if (level === "auto") delete next[phase];
        else next[phase] = level;
        setActiveModels({ efforts: next }).catch(revert);
        return next;
      });
    },
    [revert]
  );
  const handleComposerModeChange = useCallback(
    (m: "generative" | "compiled") => {
      setComposerMode(m);
      setComposerModeApi(m).catch(revert);
    },
    [revert]
  );
  const handleUiComposeModelChange = useCallback(
    (m: ModelId) => {
      setUiComposeModel(m);
      setActiveModels({ uiCompose: m }).catch(revert);
    },
    [revert]
  );

  /** Same confirm-or-say-so contract as the runtime toggle: an optimistic value
   *  that never persisted must not keep displaying as though it had. */
  const handleProfileDepthChange = useCallback(
    (d: ProfileDepth) => {
      setProfileDepth(d);
      setSettingsNotice(null);
      setProfileDepthApi(d).catch(async () => {
        await adoptServerSettings();
        setSettingsNotice(`Couldn't set profile depth to ${d.toLocaleString()} rows — reverted.`);
      });
    },
    [adoptServerSettings]
  );

  return {
    codeGenModel,
    profileDepth,
    handleProfileDepthChange,
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
    settingsNotice,
    dismissSettingsNotice: () => setSettingsNotice(null),
  };
}

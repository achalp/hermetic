// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useModelSettings } from "@/hooks/use-model-settings";

vi.mock("@/app/lib/api", () => ({
  getLocalBackendConfig: vi.fn(),
  getModelSettings: vi.fn(),
  setActiveSandboxRuntime: vi.fn(),
  setActiveModels: vi.fn(),
  setComposerMode: vi.fn(),
}));

import {
  getLocalBackendConfig,
  getModelSettings,
  setActiveSandboxRuntime,
  setActiveModels,
  setComposerMode,
} from "@/app/lib/api";

const mGetSettings = getModelSettings as ReturnType<typeof vi.fn>;
const mGetLocal = getLocalBackendConfig as ReturnType<typeof vi.fn>;
const mSetRuntime = setActiveSandboxRuntime as ReturnType<typeof vi.fn>;
const mSetModels = setActiveModels as ReturnType<typeof vi.fn>;
const mSetComposer = setComposerMode as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mGetSettings.mockReset().mockResolvedValue({
    effective: {
      models: { codeGen: "claude-opus-4-8", uiCompose: "claude-sonnet-5" },
      sandbox: { runtime: "docker" },
    },
    config: {
      models: { effort: "high", efforts: { plan: "low" } },
      composer: { mode: "compiled" },
    },
  });
  mGetLocal.mockReset().mockResolvedValue({
    mlx: { enabled: true, activeModel: "mlx-model" },
  });
  mSetRuntime.mockReset().mockResolvedValue(undefined);
  mSetModels.mockReset().mockResolvedValue(undefined);
  mSetComposer.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("useModelSettings", () => {
  it("adopts effective server settings on mount", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.codeGenModel).toBe("claude-opus-4-8"));
    expect(result.current.uiComposeModel).toBe("claude-sonnet-5");
    expect(result.current.sandboxRuntime).toBe("docker");
    expect(result.current.effort).toBe("high");
    expect(result.current.phaseEfforts).toEqual({ plan: "low" });
    expect(result.current.composerMode).toBe("compiled");
  });

  it("reflects the active local backend model", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.ollamaModel).toBe("mlx-model"));
  });

  it("handleCodeGenModelChange optimistically updates and persists", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.codeGenModel).toBe("claude-opus-4-8"));
    act(() => result.current.handleCodeGenModelChange("claude-sonnet-4-6"));
    expect(result.current.codeGenModel).toBe("claude-sonnet-4-6");
    expect(mSetModels).toHaveBeenCalledWith({ codeGen: "claude-sonnet-4-6" });
  });

  it("handleRuntimeChange persists the runtime", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.sandboxRuntime).toBe("docker"));
    act(() => result.current.handleRuntimeChange("docker"));
    expect(result.current.sandboxRuntime).toBe("docker");
    expect(mSetRuntime).toHaveBeenCalledWith("docker");
  });

  it("handleEffortChange persists the effort", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.effort).toBe("high"));
    act(() => result.current.handleEffortChange("low"));
    expect(result.current.effort).toBe("low");
    expect(mSetModels).toHaveBeenCalledWith({ effort: "low" });
  });

  it("handlePhaseEffortChange sets and clears per-phase overrides", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.phaseEfforts).toEqual({ plan: "low" }));
    act(() => result.current.handlePhaseEffortChange("compose", "high"));
    expect(result.current.phaseEfforts).toEqual({ plan: "low", compose: "high" });
    act(() => result.current.handlePhaseEffortChange("plan", "auto"));
    expect(result.current.phaseEfforts).toEqual({ compose: "high" });
  });

  it("handleComposerModeChange persists the composer mode", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.composerMode).toBe("compiled"));
    act(() => result.current.handleComposerModeChange("generative"));
    expect(result.current.composerMode).toBe("generative");
    expect(mSetComposer).toHaveBeenCalledWith("generative");
  });

  it("handleUiComposeModelChange persists the ui-compose model", async () => {
    const { result } = renderHook(() => useModelSettings());
    await waitFor(() => expect(result.current.uiComposeModel).toBe("claude-sonnet-5"));
    act(() => result.current.handleUiComposeModelChange("claude-opus-5"));
    expect(result.current.uiComposeModel).toBe("claude-opus-5");
    expect(mSetModels).toHaveBeenCalledWith({ uiCompose: "claude-opus-5" });
  });
});

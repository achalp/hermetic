// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { InferenceSection } from "@/app/components/settings/inference-section";

const api = vi.hoisted(() => ({
  getLocalLlmPlatform: vi.fn(async () => ({ os: "darwin", arch: "arm64" })),
  getProviders: vi.fn(async () => ({
    active: "anthropic",
    activeLabel: "Anthropic",
    configured: ["anthropic"],
    model: "claude",
  })),
  getRuntimes: vi.fn(async () => [
    { id: "docker", label: "Docker", available: true },
    { id: "microsandbox", label: "Microsandbox", available: false },
  ]),
  setActiveProvider: vi.fn(async () => ({ active: "anthropic", activeLabel: "Anthropic" })),
  // Used by the embedded LocalBackendSection:
  getLocalLlmStatus: vi.fn(async () => ({ running: false, systemRamGb: 16 })),
  getLocalLlmModels: vi.fn(async () => ({ models: [] })),
  getLocalLlmRecommendations: vi.fn(async () => ({ models: [] })),
  putLocalLlmConfig: vi.fn(async () => undefined),
  startLocalLlmServer: vi.fn(async () => undefined),
  stopLocalLlmServer: vi.fn(async () => undefined),
  downloadLocalLlmModel: vi.fn(async () => ({ body: null })),
  deleteLocalLlmModel: vi.fn(async () => undefined),
}));

vi.mock("@/app/lib/api", () => ({
  ...api,
  ApiError: class ApiError extends Error {},
}));

beforeEach(() => {
  api.getLocalLlmPlatform.mockResolvedValue({ os: "darwin", arch: "arm64" });
  api.getProviders.mockResolvedValue({
    active: "anthropic",
    activeLabel: "Anthropic",
    configured: ["anthropic"],
    model: "claude",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseProps = {
  codeGenModel: "claude-sonnet-4" as never,
  uiComposeModel: "claude-sonnet-4" as never,
  effort: "auto",
  onEffortChange: vi.fn(),
  phaseEfforts: {} as Record<string, string>,
  onPhaseEffortChange: vi.fn(),
  composerMode: "generative" as const,
  onComposerModeChange: vi.fn(),
  onCodeGenModelChange: vi.fn(),
  onUiComposeModelChange: vi.fn(),
  sandboxRuntime: "docker" as never,
  onSandboxRuntimeChange: vi.fn(),
  ollamaModel: null as string | null,
  onOllamaModelChange: vi.fn(),
};

describe("InferenceSection", () => {
  it("renders provider, local models, model selectors, and runtime", async () => {
    render(<InferenceSection {...baseProps} />);
    expect(screen.getByText("PROVIDER")).toBeInTheDocument();
    expect(screen.getByText("LOCAL MODELS")).toBeInTheDocument();
    expect(screen.getByText("MODELS")).toBeInTheDocument();
    expect(screen.getByText("SANDBOX RUNTIME")).toBeInTheDocument();
    // Provider label resolves once getProviders returns
    await waitFor(() => expect(screen.getByText("Anthropic")).toBeInTheDocument());
    // Backend tabs — MLX shown on darwin/arm64
    expect(screen.getByText("MLX")).toBeInTheDocument();
    expect(screen.getByText("llama.cpp")).toBeInTheDocument();
    // Model-selection phase controls
    expect(screen.getByText("Code Generation")).toBeInTheDocument();
    expect(screen.getByText("Composer Architecture")).toBeInTheDocument();
  });

  it("switches local backend tabs", async () => {
    render(<InferenceSection {...baseProps} />);
    await screen.findByText("Anthropic");
    fireEvent.click(screen.getByText("Ollama"));
    // Ollama backend section fetches its own status
    await waitFor(() => expect(api.getLocalLlmStatus).toHaveBeenCalledWith("ollama"));
  });

  it("changes a phase effort selector", async () => {
    const onPhaseEffortChange = vi.fn();
    render(<InferenceSection {...baseProps} onPhaseEffortChange={onPhaseEffortChange} />);
    await screen.findByText("Anthropic");
    const selects = screen.getAllByRole("combobox");
    // Find a phase-effort select (has an "Auto (...)" option)
    const phaseSelect = selects.find((s) =>
      Array.from(s.querySelectorAll("option")).some((o) => o.textContent?.startsWith("Auto"))
    )!;
    fireEvent.change(phaseSelect, { target: { value: "high" } });
    expect(onPhaseEffortChange).toHaveBeenCalled();
  });

  it("falls back to non-mlx backends off darwin/arm64", async () => {
    api.getLocalLlmPlatform.mockResolvedValue({ os: "linux", arch: "x64" });
    render(<InferenceSection {...baseProps} />);
    await screen.findByText("Anthropic");
    await waitFor(() => expect(screen.queryByText("MLX")).not.toBeInTheDocument());
    expect(screen.getByText("llama.cpp")).toBeInTheDocument();
  });
});

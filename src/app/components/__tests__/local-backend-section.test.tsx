// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { LocalBackendSection } from "@/app/components/local-backend-section";

const api = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
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
  api.getLocalLlmStatus.mockResolvedValue({ running: false, systemRamGb: 16 });
  api.getLocalLlmModels.mockResolvedValue({ models: [] });
  api.getLocalLlmRecommendations.mockResolvedValue({ models: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseProps = {
  onProviderChange: vi.fn(),
  isActive: false,
  activeModel: null as string | null,
};

describe("LocalBackendSection", () => {
  it("shows a checking state before status resolves", () => {
    api.getLocalLlmStatus.mockReturnValue(new Promise(() => {}));
    render(<LocalBackendSection backend="mlx" {...baseProps} />);
    expect(screen.getByText(/Checking MLX/)).toBeInTheDocument();
  });

  it("renders the not-running state with a Start button + custom download", async () => {
    render(<LocalBackendSection backend="mlx" {...baseProps} />);
    expect(await screen.findByText("Not running")).toBeInTheDocument();
    expect(screen.getByText("Start MLX")).toBeInTheDocument();
    expect(screen.getByText("16 GB RAM")).toBeInTheDocument();
    expect(screen.getByText("Download Custom Model")).toBeInTheDocument();
    // A downloaded models list appears when models exist
    expect(screen.queryByText("Downloaded Models")).not.toBeInTheDocument();
  });

  it("lists downloaded models and starts the server on click", async () => {
    api.getLocalLlmModels.mockResolvedValue({
      models: [{ name: "mlx-community/Qwen", size: 1024 }] as never,
    });
    render(<LocalBackendSection backend="mlx" {...baseProps} />);
    expect(await screen.findByText("Downloaded Models")).toBeInTheDocument();
    expect(screen.getByText("mlx-community/Qwen")).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Start")[0]);
    await waitFor(() => expect(api.startLocalLlmServer).toHaveBeenCalled());
  });

  it("renders the running state with an active model and stop button", async () => {
    api.getLocalLlmStatus.mockResolvedValue({
      running: true,
      status: "ready",
      version: "1.2",
      systemRamGb: 32,
      managed: true,
    });
    api.getLocalLlmModels.mockResolvedValue({
      models: [{ name: "llama-3", size: 2048 }] as never,
    });
    render(<LocalBackendSection backend="ollama" {...baseProps} isActive activeModel="llama-3" />);
    expect(await screen.findByText(/Running v1.2/)).toBeInTheDocument();
    expect(screen.getByText("Stop")).toBeInTheDocument();
    expect(screen.getByText(/\(active\)/)).toBeInTheDocument();
  });

  it("shows llmfit recommended models when available", async () => {
    (api.getLocalLlmRecommendations.mockResolvedValue as (v: unknown) => void)({
      models: [
        {
          name: "mlx-community/Recommended-7B",
          parameter_count: "7B",
          fit_level: "Perfect",
          score: 95,
          memory_required_gb: 8,
          estimated_tps: 42,
          gguf_sources: [],
        },
      ],
    });
    render(<LocalBackendSection backend="mlx" {...baseProps} />);
    expect(await screen.findByText("Recommended-7B")).toBeInTheDocument();
    expect(screen.getByText("Perfect")).toBeInTheDocument();
  });
});

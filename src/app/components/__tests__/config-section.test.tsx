// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { ConfigSection } from "@/app/components/settings/config-section";

const { getSettings, putSettings } = vi.hoisted(() => {
  const info = {
    keychain_available: true,
    api_keys: {
      anthropic: { set: true, source: "keychain" },
      openai: { set: false },
      e2b: { set: false },
      microsandbox: { set: false },
    },
    config: {
      providers: {
        openaiBaseUrl: "",
        openaiModel: "",
        vertexProject: "",
        vertexLocation: "",
        awsRegion: "",
      },
      sandbox: { microsandboxUrl: "", microsandboxImage: "", memoryFraction: "" },
      retention: { maxHistoryEntries: "", maxRunRecords: "" },
    },
    effective: {
      providers: {
        openaiBaseUrl: "https://api.openai.com",
        openaiModel: "gpt-4o",
        vertexProject: "proj",
        vertexLocation: "us",
        awsRegion: "us-east-1",
      },
      sandbox: {
        microsandboxUrl: "http://localhost",
        microsandboxImage: "img",
        memoryFraction: 0.5,
      },
      retention: { maxHistoryEntries: 100, maxRunRecords: 50 },
    },
  };
  return {
    getSettings: vi.fn(async () => info),
    putSettings: vi.fn(async () => info),
  };
});

vi.mock("@/app/lib/api", () => ({ getSettings, putSettings }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConfigSection", () => {
  it("shows a loading state then the settings form", async () => {
    render(<ConfigSection />);
    expect(screen.getByText("Loading configuration…")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("API KEYS")).toBeInTheDocument());
    expect(screen.getByText("PROVIDER ENDPOINTS")).toBeInTheDocument();
    expect(screen.getByText("SANDBOX")).toBeInTheDocument();
    expect(screen.getByText("RETENTION")).toBeInTheDocument();
    // Anthropic key shows a "set" badge
    expect(screen.getByText(/set · keychain/)).toBeInTheDocument();
  });

  it("edits a field and saves the configuration", async () => {
    render(<ConfigSection />);
    await waitFor(() => expect(screen.getByText("API KEYS")).toBeInTheDocument());
    const input = screen.getByLabelText("OpenAI-compatible base URL");
    fireEvent.change(input, { target: { value: "https://custom" } });
    const save = screen.getByText("Save configuration");
    fireEvent.click(save);
    await waitFor(() => expect(putSettings).toHaveBeenCalled());
  });
});

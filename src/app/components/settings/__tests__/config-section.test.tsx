// @vitest-environment jsdom
/**
 * ConfigSection tests: the end-to-end wiring the Settings UI provides —
 * load → edit → save round-trip through the api client, keychain-off
 * degradation, key-material hygiene (password inputs, no echo), and
 * server-error surfacing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import type { SettingsInfo } from "@/app/lib/api";

vi.mock("@/app/lib/api", () => ({
  getSettings: vi.fn(),
  putSettings: vi.fn(),
}));

import { getSettings, putSettings } from "@/app/lib/api";
import { ConfigSection } from "@/app/components/settings/config-section";

const BASE_INFO: SettingsInfo = {
  config: {
    providers: { openaiModel: "llama3.3" },
    sandbox: {},
    retention: {},
  },
  effective: {
    providers: {
      openaiBaseUrl: "http://from-env:1/v1",
      openaiModel: "llama3.3",
      vertexProject: null,
      vertexLocation: null,
      awsRegion: null,
    },
    sandbox: { microsandboxUrl: null, microsandboxImage: null, memoryFraction: 0.5 },
    retention: { maxHistoryEntries: 200, maxRunRecords: 200 },
  },
  api_keys: {
    anthropic: { set: true, source: "env" },
    openai: { set: false, source: null },
    e2b: { set: false, source: null },
    microsandbox: { set: false, source: null },
  },
  keychain_available: true,
};

const mockedGet = vi.mocked(getSettings);
const mockedPut = vi.mocked(putSettings);

beforeEach(() => {
  vi.clearAllMocks();
  mockedGet.mockResolvedValue(structuredClone(BASE_INFO));
  mockedPut.mockResolvedValue(structuredClone(BASE_INFO));
});

afterEach(() => cleanup());

describe("ConfigSection", () => {
  it("loads settings, shows stored values and env placeholders", async () => {
    render(<ConfigSection />);
    const model = await screen.findByLabelText<HTMLInputElement>("OpenAI-compatible model");
    expect(model.value).toBe("llama3.3"); // from runtime-config
    const baseUrl = screen.getByLabelText<HTMLInputElement>("OpenAI-compatible base URL");
    expect(baseUrl.value).toBe(""); // not in rc...
    expect(baseUrl.placeholder).toBe("http://from-env:1/v1"); // ...env shows as fallback
  });

  it("saves edited fields and new API keys through putSettings", async () => {
    const user = userEvent.setup();
    render(<ConfigSection />);
    const region = await screen.findByLabelText("AWS region (Bedrock)");
    await user.type(region, "eu-west-1");
    await user.type(screen.getByLabelText(/Anthropic API key/), "sk-new-key");
    await user.click(screen.getByRole("button", { name: /Save configuration/ }));

    await waitFor(() => expect(mockedPut).toHaveBeenCalledTimes(1));
    const update = mockedPut.mock.calls[0][0];
    expect(update.providers?.awsRegion).toBe("eu-west-1");
    expect(update.providers?.openaiModel).toBe("llama3.3"); // untouched fields preserved
    expect(update.api_keys).toEqual({ anthropic: "sk-new-key" });
    await screen.findByText("Saved");
  });

  it("does not send api_keys when none were typed", async () => {
    const user = userEvent.setup();
    render(<ConfigSection />);
    const region = await screen.findByLabelText("AWS region (Bedrock)");
    await user.type(region, "us-east-2");
    await user.click(screen.getByRole("button", { name: /Save configuration/ }));
    await waitFor(() => expect(mockedPut).toHaveBeenCalled());
    expect(mockedPut.mock.calls[0][0].api_keys).toBeUndefined();
  });

  it("key inputs are password-typed and key status shows source without material", async () => {
    render(<ConfigSection />);
    const key = await screen.findByLabelText<HTMLInputElement>(/Anthropic API key/);
    expect(key.type).toBe("password");
    expect(screen.getByText("set · env")).toBeTruthy();
    expect(key.value).toBe(""); // stored material is never echoed back
  });

  it("keychain unavailable → key inputs replaced by the env-var guidance", async () => {
    mockedGet.mockResolvedValue({
      ...structuredClone(BASE_INFO),
      keychain_available: false,
    });
    render(<ConfigSection />);
    await screen.findByText(/No OS credential service detected/);
    expect(screen.queryByLabelText(/Anthropic API key/)).toBeNull();
  });

  it("surfaces a server rejection instead of pretending success", async () => {
    mockedPut.mockRejectedValue(new Error("sandbox.memoryFraction must be a number in (0, 1]"));
    const user = userEvent.setup();
    render(<ConfigSection />);
    const fraction = await screen.findByLabelText("Sandbox memory fraction (0–1)");
    await user.type(fraction, "3");
    await user.click(screen.getByRole("button", { name: /Save configuration/ }));
    await screen.findByText(/memoryFraction must be a number/);
    expect(screen.queryByText("Saved")).toBeNull();
  });
});

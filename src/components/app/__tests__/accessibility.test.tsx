// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

vi.mock("@/lib/api", () => ({
  getProviders: vi.fn().mockResolvedValue({
    active: "anthropic",
    activeLabel: "Anthropic",
    configured: ["anthropic"],
  }),
  getRuntimes: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({ theme: "vanilla", setTheme: vi.fn() }),
  THEMES: [{ id: "vanilla", label: "Vanilla", description: "Default" }],
}));

vi.mock("@/hooks/use-click-outside", () => ({
  useClickOutside: vi.fn(),
}));

import { SettingsPanel } from "@/components/app/settings-panel";

afterEach(() => cleanup());

describe("Accessibility", () => {
  const defaultProps = {
    codeGenModel: "claude-sonnet-4-6" as const,
    uiComposeModel: "claude-sonnet-4-6" as const,
    onCodeGenModelChange: vi.fn(),
    onUiComposeModelChange: vi.fn(),
    sandboxRuntime: "docker" as const,
    onSandboxRuntimeChange: vi.fn(),
    ollamaModel: null,
    onOllamaModelChange: vi.fn(),
  };

  it("settings button has aria-label and aria-expanded", () => {
    render(<SettingsPanel {...defaultProps} />);
    const btn = screen.getByRole("button", { name: "Settings" });
    expect(btn).toBeDefined();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("settings button toggles aria-expanded on click", async () => {
    const user = userEvent.setup();
    render(<SettingsPanel {...defaultProps} />);
    const btn = screen.getByRole("button", { name: "Settings" });
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});

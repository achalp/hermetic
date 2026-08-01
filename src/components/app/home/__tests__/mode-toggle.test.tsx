// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ModeToggle } from "@/components/app/home/mode-toggle";

afterEach(() => cleanup());

describe("ModeToggle", () => {
  it("renders a radiogroup with both modes, current one checked", () => {
    render(<ModeToggle mode="ask" onModeChange={vi.fn()} />);
    expect(screen.getByRole("radiogroup", { name: "Analysis depth" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ask", checked: true })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Investigate", checked: false })).toBeTruthy();
  });

  it("clicking the other mode reports the change", async () => {
    const onModeChange = vi.fn();
    render(<ModeToggle mode="ask" onModeChange={onModeChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Investigate" }));
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("investigate");
  });

  it("arrow keys move between modes (WAI radio pattern)", async () => {
    const onModeChange = vi.fn();
    render(<ModeToggle mode="ask" onModeChange={onModeChange} />);
    screen.getByRole("radio", { name: "Ask" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onModeChange).toHaveBeenLastCalledWith("investigate");
    await userEvent.keyboard("{ArrowLeft}");
    expect(onModeChange).toHaveBeenLastCalledWith("investigate"); // wraps from ask
  });

  it("only the selected mode is in the tab order", () => {
    render(<ModeToggle mode="investigate" onModeChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Investigate" }).tabIndex).toBe(0);
    expect(screen.getByRole("radio", { name: "Ask" }).tabIndex).toBe(-1);
  });

  it("disables both options when disabled", () => {
    render(<ModeToggle mode="ask" onModeChange={vi.fn()} disabled />);
    screen.getAllByRole("radio").forEach((r) => {
      expect((r as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { AskComposer } from "@/components/app/home/ask-composer";

afterEach(() => cleanup());

function renderComposer(overrides: Partial<React.ComponentProps<typeof AskComposer>> = {}) {
  const props = {
    question: "",
    onQuestionChange: vi.fn(),
    mode: "ask" as const,
    onModeChange: vi.fn(),
    attachedLabel: null,
    onSubmit: vi.fn(),
    renderMenu: vi.fn((close: () => void) => <button onClick={close}>menu-item</button>),
    ...overrides,
  };
  render(<AskComposer {...props} />);
  return props;
}

describe("AskComposer", () => {
  it("submit is disabled without a question", () => {
    renderComposer();
    const submit = screen.getByRole("button", { name: /Analyze/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it("submit with a question but NO data opens the Add-data menu instead of dead-ending", async () => {
    const props = renderComposer({ question: "top products?" });
    await userEvent.click(screen.getByRole("button", { name: /Analyze/ }));
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("menu-item")).toBeTruthy();
  });

  it("submits question and mode when data is attached", async () => {
    const props = renderComposer({ question: "  top products?  ", attachedLabel: "sales.csv" });
    await userEvent.click(screen.getByRole("button", { name: /Analyze/ }));
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("top products?", "ask");
  });

  it("Cmd+Enter submits from the textarea", async () => {
    const props = renderComposer({ question: "why churn?", attachedLabel: "sales.csv" });
    screen.getByLabelText("Ask a question about your data").focus();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("why churn?", "ask");
  });

  it("shows the attached data chip and relabels the attach button to Change data", () => {
    renderComposer({ attachedLabel: "sales.csv" });
    expect(screen.getByText("sales.csv")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Change data/ })).toBeTruthy();
  });

  it("investigate mode relabels the submit button and the hint line", () => {
    renderComposer({ mode: "investigate" });
    expect(screen.getByRole("button", { name: "Investigate" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("multi-step deep dive");
  });

  it("menu toggles from the Add data button and closes via the render-prop close", async () => {
    renderComposer();
    const trigger = screen.getByRole("button", { name: /Add data/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(screen.getByText("menu-item"));
    expect(screen.queryByText("menu-item")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape closes the menu", async () => {
    renderComposer();
    await userEvent.click(screen.getByRole("button", { name: /Add data/ }));
    expect(screen.getByText("menu-item")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("menu-item")).toBeNull();
  });

  it("disables input and submit while loading, with an in-progress label", () => {
    renderComposer({ question: "q", attachedLabel: "sales.csv", isLoading: true });
    expect(
      (screen.getByLabelText("Ask a question about your data") as HTMLTextAreaElement).disabled
    ).toBe(true);
    const submit = screen.getByRole("button", { name: /Analyzing/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });
});

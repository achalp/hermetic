// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ExampleCards } from "@/components/app/home/example-cards";

afterEach(() => cleanup());

describe("ExampleCards", () => {
  it("renders three example cards as buttons with descriptive labels", () => {
    render(<ExampleCards onRun={vi.fn()} />);
    const cards = screen.getAllByRole("button", { name: /Run on the sample dataset/ });
    expect(cards).toHaveLength(3);
  });

  it("chart previews carry accessible descriptions", () => {
    render(<ExampleCards onRun={vi.fn()} />);
    expect(screen.getByRole("img", { name: /Bar chart preview/ })).toBeTruthy();
    expect(screen.getByRole("img", { name: /Line chart preview/ })).toBeTruthy();
  });

  it("clicking an ask example runs its question in ask mode", async () => {
    const onRun = vi.fn();
    render(<ExampleCards onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: /Break down revenue by region/ }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      question: "Break down revenue by region.",
      mode: "ask",
    });
  });

  it("the win-rate example runs in investigate mode", async () => {
    const onRun = vi.fn();
    render(<ExampleCards onRun={onRun} />);
    await userEvent.click(screen.getByRole("button", { name: /win rates trending up/ }));
    expect(onRun).toHaveBeenCalledExactlyOnceWith({
      question: "Are win rates trending up? Investigate what's driving the change.",
      mode: "investigate",
    });
  });

  it("preview marks use series theme tokens, never hex (SSR-safe across themes)", () => {
    render(<ExampleCards onRun={vi.fn()} />);
    const line = screen.getByRole("img", { name: /Line chart preview/ });
    const strokes = [...line.querySelectorAll("polyline")].map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual(["var(--color-series-1)", "var(--color-series-3)"]);
  });
});

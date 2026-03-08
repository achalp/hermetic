// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ActionButton } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";

afterEach(() => cleanup());

describe("ActionButton", () => {
  it("renders children", () => {
    render(<ActionButton>Save</ActionButton>);
    expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  });

  it("applies base styles", () => {
    render(<ActionButton>Click</ActionButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-surface-btn");
    expect(btn.className).toContain("text-t-btn");
    expect(btn.style.borderRadius).toBe("var(--radius-badge)");
  });

  it("forwards disabled prop", () => {
    render(<ActionButton disabled>Click</ActionButton>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("fires onClick", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<ActionButton onClick={handler}>Click</ActionButton>);
    await user.click(screen.getByRole("button"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("merges custom className", () => {
    render(<ActionButton className="extra">Click</ActionButton>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-surface-btn");
    expect(btn.className).toContain("extra");
  });

  it("merges custom style", () => {
    render(<ActionButton style={{ color: "red" }}>Click</ActionButton>);
    const btn = screen.getByRole("button");
    expect(btn.style.color).toBe("red");
    expect(btn.style.borderRadius).toBe("var(--radius-badge)");
  });
});

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Content</Card>);
    expect(screen.getByText("Content")).toBeDefined();
  });

  it("applies base styles", () => {
    render(<Card data-testid="card">Content</Card>);
    const el = screen.getByTestId("card");
    expect(el.className).toContain("theme-card");
    expect(el.className).toContain("border-border-default");
    expect(el.style.borderRadius).toBe("var(--radius-card)");
    expect(el.style.boxShadow).toBe("var(--shadow-card)");
  });

  it("forwards ref", () => {
    const ref = React.createRef<HTMLDivElement>();
    render(<Card ref={ref}>Content</Card>);
    expect(ref.current).toBeInstanceOf(HTMLDivElement);
  });

  it("merges custom className", () => {
    render(
      <Card className="opacity-40" data-testid="card">
        Content
      </Card>
    );
    const el = screen.getByTestId("card");
    expect(el.className).toContain("theme-card");
    expect(el.className).toContain("opacity-40");
  });

  it("merges custom style", () => {
    render(
      <Card style={{ maxHeight: "100px" }} data-testid="card">
        Content
      </Card>
    );
    const el = screen.getByTestId("card");
    expect(el.style.maxHeight).toBe("100px");
    expect(el.style.borderRadius).toBe("var(--radius-card)");
  });
});

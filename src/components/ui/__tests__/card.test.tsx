// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { Card } from "@/components/ui/card";

afterEach(() => cleanup());

describe("Card", () => {
  it("applies bg-panel class instead of inline background style", () => {
    const { container } = render(<Card>Content</Card>);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("bg-panel");
    expect(div.style.background).toBe("");
  });

  it("forwards custom className", () => {
    const { container } = render(<Card className="custom-class">Content</Card>);
    const div = container.firstElementChild as HTMLElement;
    expect(div.className).toContain("custom-class");
    expect(div.className).toContain("bg-panel");
  });

  it("forwards style prop without injecting background", () => {
    const { container } = render(<Card style={{ color: "red" }}>Content</Card>);
    const div = container.firstElementChild as HTMLElement;
    expect(div.style.color).toBe("red");
    expect(div.style.background).toBe("");
  });
});

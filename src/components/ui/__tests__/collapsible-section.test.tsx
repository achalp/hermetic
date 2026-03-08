// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { CollapsibleSection } from "@/components/ui/collapsible-section";

afterEach(() => cleanup());

describe("CollapsibleSection", () => {
  it("renders title and children when open", () => {
    render(
      <CollapsibleSection title="My Section">
        <p>Content here</p>
      </CollapsibleSection>
    );
    expect(screen.getByText("My Section")).toBeDefined();
    expect(screen.getByText("Content here")).toBeDefined();
  });

  it("hides children when defaultCollapsed", () => {
    render(
      <CollapsibleSection title="Collapsed" defaultCollapsed>
        <p>Hidden content</p>
      </CollapsibleSection>
    );
    expect(screen.getByText("Collapsed")).toBeDefined();
    expect(screen.queryByText("Hidden content")).toBeNull();
  });

  it("toggles on click", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Toggle Me" defaultCollapsed>
        <p>Toggle content</p>
      </CollapsibleSection>
    );

    expect(screen.queryByText("Toggle content")).toBeNull();
    await user.click(screen.getByRole("button"));
    expect(screen.getByText("Toggle content")).toBeDefined();
    await user.click(screen.getByRole("button"));
    expect(screen.queryByText("Toggle content")).toBeNull();
  });

  it("has aria-expanded attribute", async () => {
    const user = userEvent.setup();
    render(
      <CollapsibleSection title="Aria Test">
        <p>Content</p>
      </CollapsibleSection>
    );
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    await user.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders meta content", () => {
    render(
      <CollapsibleSection title="Title" meta="5 items">
        <p>Content</p>
      </CollapsibleSection>
    );
    expect(screen.getByText("5 items")).toBeDefined();
  });

  it("collapses when parent collapsed prop changes", () => {
    const { rerender } = render(
      <CollapsibleSection title="Parent Control" collapsed={false}>
        <p>Visible</p>
      </CollapsibleSection>
    );
    expect(screen.getByText("Visible")).toBeDefined();

    rerender(
      <CollapsibleSection title="Parent Control" collapsed={true}>
        <p>Visible</p>
      </CollapsibleSection>
    );
    expect(screen.queryByText("Visible")).toBeNull();
  });
});

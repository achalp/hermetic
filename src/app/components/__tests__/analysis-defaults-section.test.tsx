// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AnalysisDefaultsSection } from "@/app/components/settings/analysis-defaults-section";

afterEach(cleanup);

const baseProps = {
  defaultStyle: "dashboard",
  onDefaultStyleChange: vi.fn(),
  schemaMode: "metadata",
  onSchemaModeChange: vi.fn(),
  composerSight: "blind",
  onComposerSightChange: vi.fn(),
};

describe("AnalysisDefaultsSection", () => {
  it("renders the section groups", () => {
    render(<AnalysisDefaultsSection {...baseProps} />);
    expect(screen.getByText("DEFAULT STYLE")).toBeInTheDocument();
    expect(screen.getByText("SCHEMA MODE")).toBeInTheDocument();
    expect(screen.getByText("COMPOSER SIGHT")).toBeInTheDocument();
    expect(screen.getByText("Metadata")).toBeInTheDocument();
    expect(screen.getByText("Blind")).toBeInTheDocument();
  });

  it("fires callbacks for schema mode and composer sight toggles", () => {
    const onSchemaModeChange = vi.fn();
    const onComposerSightChange = vi.fn();
    render(
      <AnalysisDefaultsSection
        {...baseProps}
        onSchemaModeChange={onSchemaModeChange}
        onComposerSightChange={onComposerSightChange}
      />
    );
    fireEvent.click(screen.getByText("Sample"));
    expect(onSchemaModeChange).toHaveBeenCalledWith("sample");
    fireEvent.click(screen.getByText("Sighted"));
    expect(onComposerSightChange).toHaveBeenCalledWith("sighted");
  });
});

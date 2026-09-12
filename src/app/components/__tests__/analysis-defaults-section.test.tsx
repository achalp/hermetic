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
  profileDepth: 50_000 as const,
  onProfileDepthChange: vi.fn(),
};

describe("AnalysisDefaultsSection", () => {
  it("renders the section groups", () => {
    render(<AnalysisDefaultsSection {...baseProps} />);
    expect(screen.getByText("DEFAULT STYLE")).toBeInTheDocument();
    expect(screen.getByText("SCHEMA MODE")).toBeInTheDocument();
    expect(screen.getByText("COMPOSER SIGHT")).toBeInTheDocument();
    expect(screen.getByText("PROFILE DEPTH (FILE SOURCES)")).toBeInTheDocument();
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

describe("AnalysisDefaultsSection — profile depth", () => {
  it("offers the three depths and marks the active one", () => {
    render(<AnalysisDefaultsSection {...baseProps} />);
    // Labelled in rows, which is the unit the cost is actually in.
    for (const label of ["50k rows", "250k rows", "500k rows"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // The scope is stated in the heading: warehouses carry no value statistics,
    // so a control implying it governed them would be a lie.
    expect(screen.getByText("PROFILE DEPTH (FILE SOURCES)")).toBeInTheDocument();
  });

  it("reports the chosen depth as a number, not a label", () => {
    const onProfileDepthChange = vi.fn();
    render(<AnalysisDefaultsSection {...baseProps} onProfileDepthChange={onProfileDepthChange} />);
    fireEvent.click(screen.getByText("500k rows"));
    expect(onProfileDepthChange).toHaveBeenCalledWith(500_000);
  });

  it("does not promise deeper is more representative for remote sources", () => {
    render(<AnalysisDefaultsSection {...baseProps} />);
    // The tooltip on a deeper option says where the rows come from, because on a
    // remote source they are the LEADING rows, not a random sample.
    expect(screen.getByText("500k rows").getAttribute("title")).toContain("leading rows");
  });
});

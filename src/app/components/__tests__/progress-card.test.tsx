// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProgressCard } from "@/app/components/progress-card";
import type { StreamState } from "@/lib/contracts/stream-state";

const { stopAnalysis } = vi.hoisted(() => ({ stopAnalysis: vi.fn(async () => {}) }));
vi.mock("@/app/lib/api", () => ({ stopAnalysis }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ProgressCard", () => {
  it("renders steps with the active label as heading and shows elapsed", () => {
    render(
      <ProgressCard
        steps={[
          { label: "Did a thing", status: "done" },
          { label: "Doing a thing", status: "active" },
          { label: "Next thing", status: "upcoming" },
        ]}
        state={{ __exec: { elapsed_ms: 65000, fraction: 0.5 } } as StreamState}
      />
    );
    // Heading + step label both render "Doing a thing"
    expect(screen.getAllByText("Doing a thing").length).toBeGreaterThan(0);
    expect(screen.getByText("1m 05s")).toBeInTheDocument();
  });

  it("collapses when the header is clicked", () => {
    render(
      <ProgressCard
        steps={[{ label: "Working", status: "active" }]}
        state={undefined}
        defaultExpanded
      />
    );
    const header = screen.getByRole("button", { expanded: true });
    fireEvent.click(header);
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("stops the analysis when a runId is present", async () => {
    render(
      <ProgressCard
        steps={[{ label: "Working", status: "active" }]}
        state={{ __runId: "run-1" } as StreamState}
      />
    );
    fireEvent.click(screen.getByText("Stop analysis"));
    expect(stopAnalysis).toHaveBeenCalledWith("run-1");
  });
});

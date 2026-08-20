// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Spec } from "@/lib/contracts/spec";
import {
  PipelineProgress,
  InvestigateProgress,
  InvestigationCaveats,
} from "@/app/components/analysis-progress";

vi.mock("@/app/lib/api", () => ({ stopAnalysis: vi.fn(async () => {}) }));

afterEach(cleanup);

function specWith(state: Record<string, unknown>): Spec {
  return { root: "", elements: {}, state } as unknown as Spec;
}

describe("PipelineProgress", () => {
  it("shows a generic message with no progress state", () => {
    render(<PipelineProgress spec={specWith({})} drillStack={[]} previousSpec={null} />);
    expect(screen.getByText("Building visualization...")).toBeInTheDocument();
  });

  it("shows a drill-down message", () => {
    render(
      <PipelineProgress
        spec={specWith({})}
        drillStack={[{ question: "q", segmentLabel: "West", spec: {} as Spec }]}
        previousSpec={null}
      />
    );
    expect(screen.getByText("Drilling down...")).toBeInTheDocument();
  });

  it("renders the file-pipeline stepper from progress state", () => {
    render(
      <PipelineProgress
        spec={specWith({ __progress: { stage: "computing", step: 2, total: 3 } })}
        drillStack={[]}
        previousSpec={null}
      />
    );
    expect(screen.getByText("Analyzed your data")).toBeInTheDocument();
    expect(screen.getAllByText("Running computations...").length).toBeGreaterThan(0);
  });

  it("returns null once the dashboard root exists", () => {
    const { container } = render(
      <PipelineProgress
        spec={{ root: "x", elements: {}, state: {} } as unknown as Spec}
        drillStack={[]}
        previousSpec={null}
      />
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("InvestigateProgress", () => {
  it("renders the plan approach + steps", () => {
    render(
      <InvestigateProgress
        spec={specWith({
          __progress: { stage: "investigating" },
          __plan: {
            approach: "Split into drivers.",
            steps: [
              { index: 0, question: "What is revenue?", rationale: "Baseline.", status: "done" },
              { index: 1, question: "Where did it fall?", rationale: "", status: "running" },
              { index: 2, question: "Broken", rationale: "", status: "failed" },
            ],
          },
          __error: "boom",
        })}
      />
    );
    expect(screen.getAllByText("Running sub-questions...").length).toBeGreaterThan(0);
    expect(screen.getByText(/Split into drivers/)).toBeInTheDocument();
    expect(screen.getByText(/What is revenue\?/)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});

describe("InvestigationCaveats", () => {
  it("renders nothing when clean", () => {
    const { container } = render(<InvestigationCaveats spec={specWith({})} />);
    expect(container.firstChild).toBeNull();
  });

  it("surfaces ungrounded figures and data-quality notes", () => {
    render(
      <InvestigationCaveats
        spec={specWith({
          __grounding: { ok: false, ungrounded: ["42%"] },
          __dataQuality: {
            failed: [{ stepNo: 3, question: "bad step" }],
            degraded: [{ stepNo: 2, question: "weak step", reason: "few rows" }],
            removed: [],
          },
        })}
      />
    );
    expect(screen.getByText(/Verify these figures/)).toBeInTheDocument();
    expect(screen.getByText(/Data-quality notes/)).toBeInTheDocument();
    expect(screen.getByText(/Step 3 failed/)).toBeInTheDocument();
    expect(screen.getByText(/Step 2 degraded/)).toBeInTheDocument();
  });
});

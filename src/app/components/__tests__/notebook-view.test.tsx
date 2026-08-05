// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Spec } from "@/spec/react";
import { NotebookView, buildNotebookCells } from "@/app/components/notebook-view";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { InvestigationTrace, TraceStep } from "@/lib/contracts/investigation";
import { rerunInvestigateStep } from "@/app/lib/api";

vi.mock("@/app/lib/api", () => ({
  rerunInvestigateStep: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CELL_SPEC: Spec = {
  root: "cell",
  elements: {
    cell: {
      type: "LayoutColumn",
      props: { gap: 4 },
      children: ["insight"],
    },
    insight: {
      type: "TextBlock",
      props: { content: "Revenue reached 142300.", variant: "insight" },
    },
  } as Spec["elements"],
};

function specWith(state: Record<string, unknown>): Spec {
  return { root: "", elements: {}, state };
}

const PLAN_STATE = {
  __plan: {
    approach: "Break the question into revenue and churn drivers.",
    steps: [
      { index: 0, question: "What is total revenue?", rationale: "Baseline.", status: "done" },
      { index: 1, question: "Where did churn spike?", rationale: "Driver.", status: "running" },
      {
        index: 2,
        question: "Did discounts cause it?",
        rationale: "Hypothesis.",
        status: "pending",
      },
      {
        index: 3,
        question: "Broken step",
        rationale: "Will fail.",
        status: "failed",
        error: "KeyError: 'foo'",
      },
    ],
  },
  __cells: {
    "0": { status: "success", cellSpec: CELL_SPEC },
  },
};

const TRACE: InvestigationTrace = {
  approach: "Trace approach.",
  originalQuestion: "Why did revenue drop?",
  steps: [
    {
      index: 0,
      stepNo: 1,
      question: "What is total revenue?",
      rationale: "Baseline.",
      status: "success",
      source: "initial",
      depends_on: [],
      code: "import pandas as pd\nprint('hi')",
      results: { total: 142300 },
      datasets: { main: [{ region: "West", revenue: 89000 }] },
      execution_ms: 2300,
      cellSpec: CELL_SPEC,
    },
    {
      index: 1,
      stepNo: 2,
      question: "Composer follow-up",
      rationale: "Gap.",
      status: "success",
      source: "composer",
      depends_on: [0],
    },
  ],
  decisions: [],
};

const ARTIFACTS: CachedArtifacts = {
  code: "",
  question: "Why did revenue drop?",
  results: {},
  chart_data: {},
  datasets: {},
  execution_ms: 0,
  investigation: TRACE,
};

describe("buildNotebookCells", () => {
  it("builds cells from live plan + cells state", () => {
    const cells = buildNotebookCells(specWith(PLAN_STATE), null);
    expect(cells).toHaveLength(4);
    expect(cells[0].status).toBe("done");
    expect(cells[0].cellSpec).toBe(CELL_SPEC);
    expect(cells[1].status).toBe("running");
    expect(cells[2].status).toBe("pending");
    expect(cells[3].status).toBe("failed");
    expect(cells[3].error).toContain("KeyError");
  });

  it("falls back to the audit trail when spec has no plan", () => {
    const cells = buildNotebookCells(null, ARTIFACTS);
    expect(cells).toHaveLength(2);
    expect(cells[0].trace?.code).toContain("pandas");
    expect(cells[1].source).toBe("composer");
  });

  it("enriches plan cells with trail data when both are present", () => {
    const cells = buildNotebookCells(specWith(PLAN_STATE), ARTIFACTS);
    expect(cells[0].trace?.execution_ms).toBe(2300);
    expect(cells[1].source).toBe("composer");
  });
});

describe("NotebookView", () => {
  it("renders filled, running, pending, and failed cells", () => {
    render(<NotebookView spec={specWith(PLAN_STATE)} isStreaming={true} />);
    // Filled cell renders its composed output
    expect(screen.getByText("Revenue reached 142300.")).toBeInTheDocument();
    // Running + pending stubs
    expect(screen.getByText("Running analysis…")).toBeInTheDocument();
    expect(screen.getByText("Waiting for upstream steps…")).toBeInTheDocument();
    // Failed cell shows the error
    expect(screen.getByText(/KeyError: 'foo'/)).toBeInTheDocument();
    // Approach line
    expect(screen.getByText(/revenue and churn drivers/)).toBeInTheDocument();
  });

  it("renders code and data disclosures from the audit trail", () => {
    render(<NotebookView spec={specWith(PLAN_STATE)} artifacts={ARTIFACTS} isStreaming={false} />);
    expect(screen.getByText("Code")).toBeInTheDocument();
    expect(screen.getByText(/Data \(1 rows?\)/)).toBeInTheDocument();
    expect(screen.getByText("2.3s")).toBeInTheDocument();
  });

  it("shows a planning state when no cells exist yet", () => {
    render(<NotebookView spec={specWith({})} isStreaming={true} />);
    expect(screen.getByText("Planning the investigation…")).toBeInTheDocument();
  });

  it("registers export handlers upward (and renders no export buttons itself)", () => {
    const onExportApiChange = vi.fn();
    const { unmount } = render(
      <NotebookView
        spec={specWith(PLAN_STATE)}
        artifacts={ARTIFACTS}
        isStreaming={false}
        onExportApiChange={onExportApiChange}
      />
    );
    // The notebook exposes its export API to the page menu, not local buttons.
    const api = onExportApiChange.mock.calls.at(-1)?.[0];
    expect(api).toMatchObject({
      markdown: expect.any(Function),
      html: expect.any(Function),
      pdf: expect.any(Function),
    });
    expect(screen.queryByText("⬇ Markdown")).not.toBeInTheDocument();
    expect(screen.queryByText("⬇ HTML")).not.toBeInTheDocument();
    // Unmounting (e.g. switching to Dashboard view) clears the registration.
    unmount();
    expect(onExportApiChange).toHaveBeenLastCalledWith(null);
  });

  it("registers null while streaming (not yet exportable)", () => {
    const onExportApiChange = vi.fn();
    render(
      <NotebookView
        spec={specWith(PLAN_STATE)}
        artifacts={ARTIFACTS}
        isStreaming={true}
        onExportApiChange={onExportApiChange}
      />
    );
    expect(onExportApiChange).toHaveBeenLastCalledWith(null);
  });

  it("re-runs a step and flags transitive dependents stale", async () => {
    const user = userEvent.setup();
    const freshStep: TraceStep = {
      ...TRACE.steps[0],
      execution_ms: 999,
      results: { total: 150000 },
    };
    vi.mocked(rerunInvestigateStep).mockResolvedValue({
      ok: true,
      step: freshStep,
      dependents: [1],
    });
    const onStepRerun = vi.fn();

    render(
      <NotebookView
        spec={specWith(PLAN_STATE)}
        artifacts={ARTIFACTS}
        isStreaming={false}
        csvId="csv-1"
        onStepRerun={onStepRerun}
      />
    );

    // Open the code disclosure of Step 1 and re-run with edits
    await user.click(screen.getByText("Code"));
    const editorButtons = screen.getAllByText("Re-run step");
    // Simulate an edited re-run by clicking the plain re-run (stored code).
    await user.click(editorButtons[0]);

    await waitFor(() => {
      expect(rerunInvestigateStep).toHaveBeenCalledWith({
        csvId: "csv-1",
        stepIndex: 0,
        code: undefined,
        sandboxRuntime: undefined,
      });
    });
    // Stored-code re-run is a refresh: no dependents flagged.
    await waitFor(() => expect(onStepRerun).toHaveBeenCalledWith(freshStep, []));
    expect(screen.queryByText(/stale/)).not.toBeInTheDocument();
  });

  it("renders the synthesis cell with summary, conclusion, grounding, and decision log", () => {
    const stateWithSynthesis = {
      ...PLAN_STATE,
      __synthesis: {
        summary: "Revenue fell because churn rose (Step 1).",
        conclusion: "Investigate the discount cohort next.",
      },
      __grounding: { ok: true, checkedCount: 4, ungrounded: [] },
    };
    const artifactsWithDecisions: CachedArtifacts = {
      ...ARTIFACTS,
      investigation: {
        ...TRACE,
        decisions: [
          {
            kind: "replan",
            action: "amend",
            rationale: "Need a denominator.",
            addedIndices: [1],
            removedIndices: [],
          },
        ],
      },
    };
    render(
      <NotebookView
        spec={specWith(stateWithSynthesis)}
        artifacts={artifactsWithDecisions}
        isStreaming={false}
      />
    );
    expect(screen.getByText("Synthesis")).toBeInTheDocument();
    expect(screen.getByText(/Revenue fell because churn rose/)).toBeInTheDocument();
    expect(screen.getByText(/Investigate the discount cohort next/)).toBeInTheDocument();
    expect(screen.getByText(/4 checked figures/)).toBeInTheDocument();
    expect(screen.getByText("How the agent got here")).toBeInTheDocument();
    // Summary citation renders as a superscript mark
    const sups = document.querySelectorAll("sup");
    expect(sups.length).toBeGreaterThan(0);
  });
});

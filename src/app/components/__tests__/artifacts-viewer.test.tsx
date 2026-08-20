// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ArtifactsViewer, MiniTable, recordsToTable } from "@/app/components/artifacts-viewer";
import type { CachedArtifacts, InvestigationTrace } from "@/lib/contracts/investigation";

vi.mock("@/app/lib/api", () => ({
  rerunCode: vi.fn(async () => ({ artifacts: {} })),
  ApiError: class ApiError extends Error {},
}));

// CodeEditor lazy-loads CodeMirror (next/dynamic) — stub it so the Python/SQL
// tabs render without pulling the editor bundle into jsdom.
vi.mock("@/app/components/code-editor", () => ({
  CodeEditor: ({ value }: { value: string }) => <pre data-testid="code">{value}</pre>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TRACE: InvestigationTrace = {
  approach: "Break the question into revenue and churn drivers.",
  originalQuestion: "Why did revenue drop?",
  grounding: {
    ok: true,
    checkedCount: 3,
    ungrounded: [],
    uncitedSuccessfulSteps: [2],
    citedSteps: [],
  } as InvestigationTrace["grounding"],
  steps: [
    {
      index: 0,
      stepNo: 1,
      question: "What is total revenue?",
      rationale: "Baseline.",
      status: "success",
      source: "initial",
      depends_on: [],
      code: "print('x')",
      results: { total: 1 },
      datasets: {},
    },
    {
      index: 1,
      stepNo: 2,
      question: "Which region fell?",
      rationale: "Driver.",
      status: "degraded",
      source: "replanner",
      depends_on: [0],
      degradedReason: "few rows",
    },
    {
      index: 2,
      stepNo: 3,
      question: "Broken",
      rationale: "",
      status: "failed",
      source: "composer",
      depends_on: [],
      error: "KeyError: foo",
    },
  ],
  decisions: [
    {
      kind: "replan",
      action: "amend",
      rationale: "Need a denominator.",
      addedIndices: [1],
      removedIndices: [],
    },
  ],
};

const ARTIFACTS: CachedArtifacts = {
  code: "import pandas as pd\nprint('hi')",
  question: "Why did revenue drop?",
  results: { total: 142300 },
  chart_data: { series: [{ region: "West", revenue: 89000 }] },
  datasets: { main: [{ region: "West", revenue: 89000 }] },
  execution_ms: 2300,
  investigation: TRACE,
};

describe("recordsToTable", () => {
  it("returns empty for no records and stringifies objects", () => {
    expect(recordsToTable([])).toEqual({ columns: [], rows: [] });
    const t = recordsToTable([{ a: 1, b: { x: 2 }, c: null }]);
    expect(t.columns).toEqual(["a", "b", "c"]);
    expect(t.rows[0]).toEqual(["1", '{"x":2}', ""]);
  });
});

describe("MiniTable", () => {
  it("renders columns, rows, and a truncation note", () => {
    render(<MiniTable columns={["a"]} rows={[["1"], ["2"], ["3"]]} maxRows={2} />);
    expect(screen.getByText("Showing 2 of 3 rows")).toBeInTheDocument();
  });
});

describe("ArtifactsViewer", () => {
  it("renders the investigation trail by default", () => {
    render(<ArtifactsViewer artifacts={ARTIFACTS} />);
    expect(screen.getByText("Trail")).toBeInTheDocument();
    expect(screen.getByText("Approach")).toBeInTheDocument();
    expect(screen.getByText(/revenue and churn drivers/)).toBeInTheDocument();
    expect(screen.getByText("Sub-questions (3)")).toBeInTheDocument();
    expect(screen.getByText(/Validator: few rows/)).toBeInTheDocument();
    expect(screen.getByText(/Error: KeyError: foo/)).toBeInTheDocument();
    expect(screen.getByText("Agent decisions")).toBeInTheDocument();
  });

  it("switches to the Data tab and shows data sections", () => {
    render(<ArtifactsViewer artifacts={ARTIFACTS} />);
    fireEvent.click(screen.getByText("Data"));
    expect(screen.getByText("Results")).toBeInTheDocument();
    expect(screen.getByText("chart_data.series")).toBeInTheDocument();
    expect(screen.getByText("datasets.main")).toBeInTheDocument();
  });

  it("navigates into a step's code from the trail", () => {
    render(<ArtifactsViewer artifacts={ARTIFACTS} csvId="csv-1" />);
    fireEvent.click(screen.getByText("View code & data →"));
    // Now on the Python tab showing the step's code (stubbed editor)
    expect(screen.getByTestId("code")).toHaveTextContent("print('x')");
    expect(screen.getByText(/back to trail/)).toBeInTheDocument();
  });

  it("renders code tab for a plain (non-investigation) artifacts payload", () => {
    const plain: CachedArtifacts = { ...ARTIFACTS, investigation: undefined };
    render(<ArtifactsViewer artifacts={plain} />);
    expect(screen.getByText("Python")).toBeInTheDocument();
    expect(screen.getByTestId("code")).toHaveTextContent("import pandas as pd");
  });
});

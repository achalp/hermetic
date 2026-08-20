// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanEditPanel } from "@/app/components/plan-edit/panel";
import type { PlanEdit } from "@/hooks/use-plan-edit";

afterEach(cleanup);

function makeEdit(overrides: Partial<PlanEdit> = {}): PlanEdit {
  return {
    loaded: true,
    loadFailed: false,
    canUndo: true,
    error: null,
    pendingId: null,
    sections: [
      {
        id: "n1",
        kind: "node",
        op: "INSIGHT",
        hidden: false,
        width: "full",
        preview: "Revenue rose 12%.",
        label: "Insight",
      },
      { id: "c1", kind: "chart", hidden: false, width: "half", label: "Chart: Monthly Churn" },
      {
        id: "h1",
        kind: "node",
        op: "NOTE",
        hidden: true,
        width: "full",
        preview: "hidden note",
        label: "Note",
      },
    ],
    surface: {
      doc: { plan: { nodes: [{ op: "INSIGHT", text: "Revenue rose 12%." }] } },
      claims: [
        {
          name: "total_rev",
          cited: false,
          suggestedOp: "ANSWER",
          preview: "Total revenue was $1M.",
        },
      ],
      views: [{ id: "v1", shipped: false, kind: "table", seriesId: "step_1_revenue" }],
      sections: [],
    },
    undo: vi.fn(),
    refresh: vi.fn(),
    toggleHidden: vi.fn(),
    removeNode: vi.fn(),
    reorder: vi.fn(),
    setWidth: vi.fn(),
    saveInsight: vi.fn(),
    addClaim: vi.fn(),
    addView: vi.fn(),
    ...overrides,
  } as unknown as PlanEdit;
}

describe("PlanEditPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <PlanEditPanel edit={makeEdit()} open={false} onClose={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the full edit surface with sections, hidden, claims, and views", () => {
    render(<PlanEditPanel edit={makeEdit()} open onClose={() => {}} />);
    expect(screen.getByText("Edit dashboard")).toBeInTheDocument();
    expect(screen.getByText(/On the dashboard/)).toBeInTheDocument();
    expect(screen.getByText("Revenue rose 12%.")).toBeInTheDocument();
    expect(screen.getByText(/Hidden \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/findings \(1\)/)).toBeInTheDocument();
    expect(screen.getByText("Total revenue was $1M.")).toBeInTheDocument();
    expect(screen.getByText(/charts \(1\)/)).toBeInTheDocument();
  });

  it("adds a claim and a view", () => {
    const edit = makeEdit();
    render(<PlanEditPanel edit={edit} open onClose={() => {}} />);
    fireEvent.click(screen.getByText("Total revenue was $1M."));
    expect(edit.addClaim).toHaveBeenCalledWith("total_rev", "ANSWER");
    fireEvent.click(screen.getByText(/Table of revenue/));
    expect(edit.addView).toHaveBeenCalledWith("v1");
  });

  it("undoes and closes via the header", () => {
    const edit = makeEdit();
    const onClose = vi.fn();
    render(<PlanEditPanel edit={edit} open onClose={onClose} />);
    fireEvent.click(screen.getByText("Undo"));
    expect(edit.undo).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Close editor"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the skeleton while loading and the free-form notice with no surface", () => {
    const { rerender, container } = render(
      <PlanEditPanel edit={makeEdit({ loaded: false })} open onClose={() => {}} />
    );
    // Skeleton pulse blocks
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    rerender(
      <PlanEditPanel
        edit={makeEdit({ surface: null as unknown as PlanEdit["surface"] })}
        open
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/composed free-form/)).toBeInTheDocument();
  });
});

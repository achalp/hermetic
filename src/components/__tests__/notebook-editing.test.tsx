// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { Markdown } from "@/components/app/markdown";
import { orderedEntries, type NotebookCellModel } from "@/components/app/notebook-view";
import type { NotebookLayoutCell } from "@/lib/pipeline/investigation-trace";

afterEach(cleanup);

function stepCell(stepNo: number): NotebookCellModel {
  return { index: stepNo - 1, stepNo, question: `q${stepNo}`, status: "done" };
}

describe("Markdown", () => {
  it("renders headings, bold, italic, code, and lists", () => {
    const { container } = render(
      <Markdown content={"# Title\n\nSome **bold** and *italic* and `code`.\n\n- one\n- two"} />
    );
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("italic");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
  });

  it("renders ordered lists", () => {
    const { container } = render(<Markdown content={"1. first\n2. second"} />);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
  });
});

describe("orderedEntries", () => {
  const steps = [stepCell(1), stepCell(2), stepCell(3)];

  it("returns all step cells in order when no layout", () => {
    const out = orderedEntries(null, steps);
    expect(out.map((e) => (e.kind === "step" ? e.cell.stepNo : "md"))).toEqual([1, 2, 3]);
  });

  it("honors layout order and injects markdown cells", () => {
    const layout: NotebookLayoutCell[] = [
      { kind: "markdown", id: "a", content: "intro" },
      { kind: "step", stepNo: 2 },
      { kind: "step", stepNo: 1 },
    ];
    const out = orderedEntries(layout, steps);
    expect(out.map((e) => (e.kind === "step" ? e.cell.stepNo : `md:${e.content}`))).toEqual([
      "md:intro",
      2,
      1,
      3, // step 3 wasn't in the layout → appended
    ]);
  });

  it("drops layout step refs that no longer exist", () => {
    const layout: NotebookLayoutCell[] = [
      { kind: "step", stepNo: 9 }, // gone
      { kind: "step", stepNo: 1 },
    ];
    const out = orderedEntries(layout, steps);
    expect(out.map((e) => (e.kind === "step" ? e.cell.stepNo : "md"))).toEqual([1, 2, 3]);
  });

  it("never duplicates a step even if the layout lists it twice", () => {
    const layout: NotebookLayoutCell[] = [
      { kind: "step", stepNo: 1 },
      { kind: "step", stepNo: 1 },
    ];
    const out = orderedEntries(layout, steps);
    const ones = out.filter((e) => e.kind === "step" && e.cell.stepNo === 1);
    expect(ones).toHaveLength(1);
  });
});

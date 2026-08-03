import { describe, it, expect } from "vitest";
import { buildNotebookMarkdown, buildNotebookHtml } from "@/lib/notebook-export";
import type { InvestigationTrace, TraceStep } from "@/lib/pipeline/investigation-trace";
import type { Spec } from "@/spec/core";

const cellSpec: Spec = {
  root: "c",
  elements: {
    c: { type: "LayoutColumn", props: {}, children: ["t"] },
    t: { type: "TextBlock", props: { content: "Revenue rose sharply.", variant: "insight" } },
  } as Spec["elements"],
};

function step(partial: Partial<TraceStep> & { index: number }): TraceStep {
  return {
    stepNo: partial.index + 1,
    question: `Q${partial.index + 1}`,
    rationale: "because",
    status: "success",
    source: "initial",
    depends_on: [],
    ...partial,
  } as TraceStep;
}

function trace(partial: Partial<InvestigationTrace>): InvestigationTrace {
  return {
    approach: "Look at revenue.",
    originalQuestion: "Why did revenue change?",
    steps: [],
    decisions: [],
    ...partial,
  };
}

describe("buildNotebookMarkdown", () => {
  it("renders title, approach, SQL, code, insight, and a data table", () => {
    const md = buildNotebookMarkdown(
      trace({
        steps: [
          step({
            index: 0,
            sql: "SELECT * FROM t",
            code: "import pandas as pd",
            cellSpec,
            datasets: { main: [{ region: "West", rev: 100 }] },
          }),
        ],
      })
    );
    expect(md).toContain("# Why did revenue change?");
    expect(md).toContain("**Approach:** Look at revenue.");
    expect(md).toContain("## Step 1 — Q1");
    expect(md).toContain("```sql\nSELECT * FROM t\n```");
    expect(md).toContain("```python\nimport pandas as pd\n```");
    expect(md).toContain("Revenue rose sharply.");
    expect(md).toContain("| region | rev |");
    expect(md).toContain("| West | 100 |");
  });

  it("respects the notebook layout order and includes markdown cells", () => {
    const md = buildNotebookMarkdown(
      trace({
        steps: [step({ index: 0 }), step({ index: 1 })],
        notebook: {
          cells: [
            { kind: "markdown", id: "m", content: "# My notes" },
            { kind: "step", stepNo: 2 },
            { kind: "step", stepNo: 1 },
          ],
        },
      })
    );
    const notesAt = md.indexOf("My notes");
    const step2At = md.indexOf("## Step 2");
    const step1At = md.indexOf("## Step 1");
    expect(notesAt).toBeGreaterThan(-1);
    expect(notesAt).toBeLessThan(step2At);
    expect(step2At).toBeLessThan(step1At);
  });

  it("notes failed and removed steps", () => {
    const md = buildNotebookMarkdown(
      trace({
        steps: [
          step({ index: 0, status: "failed", error: "boom" }),
          step({ index: 1, status: "removed" }),
        ],
      })
    );
    expect(md).toContain("**Failed:** boom");
    expect(md).toContain("Dropped by the re-planner");
  });

  it("appends the synthesis and grounding verdict", () => {
    const md = buildNotebookMarkdown(
      trace({ steps: [step({ index: 0 })], grounding: { ok: true, checkedCount: 3 } as never }),
      { summary: "Big picture.", conclusion: "Do X next." }
    );
    expect(md).toContain("## Synthesis");
    expect(md).toContain("Big picture.");
    expect(md).toContain("Do X next.");
    expect(md).toContain("3 figure(s)");
  });
});

describe("buildNotebookHtml", () => {
  it("produces a self-contained document with inlined styles and chart images", () => {
    const images = new Map<number, string>([[1, "data:image/png;base64,AAAA"]]);
    const html = buildNotebookHtml(
      trace({
        steps: [
          step({
            index: 0,
            sql: "SELECT 1",
            code: "x=1",
            cellSpec,
            datasets: { main: [{ region: "West", rev: 100 }] },
          }),
        ],
      }),
      { summary: "Top line.", conclusion: "Next steps." },
      images
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>"); // CSS inlined, not linked
    expect(html).not.toMatch(/<link[^>]+stylesheet/);
    // No external resource references — fully self-contained
    expect(html).not.toMatch(/(href|src)="https?:\/\//);
    // The captured chart image is embedded as a data URI
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    // Content present and HTML-escaped
    expect(html).toContain("Why did revenue change?");
    expect(html).toContain("SELECT 1");
    expect(html).toContain("<td>West</td>");
    expect(html).toContain("Top line.");
  });

  it("escapes HTML-significant characters in content", () => {
    const html = buildNotebookHtml(
      trace({
        originalQuestion: "A < B & C > D",
        steps: [step({ index: 0, code: "if a < b: pass" })],
      })
    );
    expect(html).toContain("A &lt; B &amp; C &gt; D");
    expect(html).toContain("if a &lt; b: pass");
    expect(html).not.toContain("if a < b: pass");
  });

  it("respects layout order with markdown cells", () => {
    const html = buildNotebookHtml(
      trace({
        steps: [step({ index: 0 }), step({ index: 1 })],
        notebook: {
          cells: [
            { kind: "markdown", id: "m", content: "## Heading\n\n- a\n- b" },
            { kind: "step", stepNo: 2 },
            { kind: "step", stepNo: 1 },
          ],
        },
      })
    );
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<li>a</li>");
    expect(html.indexOf("Heading")).toBeLessThan(html.indexOf("Q2"));
    expect(html.indexOf("Q2")).toBeLessThan(html.indexOf("Q1"));
  });
});

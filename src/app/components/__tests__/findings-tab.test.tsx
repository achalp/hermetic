// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { FindingsTab, GroundingAdvisories, parseCodeRefLine } from "@/app/components/findings-tab";
import { InvestigationCaveats } from "@/app/components/analysis-progress";
import type { FindingsManifest } from "@/lib/contracts/findings";
import type { GroundingReport } from "@/lib/contracts/grounding";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MANIFEST: FindingsManifest = {
  manifest_version: "1.0",
  findings: [
    {
      name: "median_revenue",
      definition: "median of revenue over all rows",
      dtype: "scalar",
      unit: "usd",
      value: 1234.5,
      tags: ["question_primary"],
      code_ref: "script.py:41",
      redeclarations: 2,
    },
    {
      name: "region_shares",
      definition: "share of revenue by region",
      dtype: "shares",
      value: { west: 0.4, east: 0.6 },
    },
  ],
};

describe("FindingsTab", () => {
  it("renders entries with name, dtype/unit/tag badges, values, and re-declared marker", () => {
    render(<FindingsTab findings={MANIFEST} />);

    expect(screen.getByText("median_revenue")).toBeTruthy();
    expect(screen.getByText("scalar")).toBeTruthy();
    expect(screen.getByText("usd")).toBeTruthy();
    expect(screen.getByText("question_primary")).toBeTruthy();
    expect(screen.getByText("median of revenue over all rows")).toBeTruthy();
    expect(screen.getByText("re-declared x2")).toBeTruthy();
    // Scalar inline
    expect(screen.getByText("1234.5")).toBeTruthy();
    // Small object as key: value rows
    expect(screen.getByText("west:")).toBeTruthy();
    expect(screen.getByText("0.4")).toBeTruthy();
  });

  it("code_ref is a real link: clicking navigates via onOpenCodeRef with the parsed line", async () => {
    const onOpenCodeRef = vi.fn();
    render(<FindingsTab findings={MANIFEST} onOpenCodeRef={onOpenCodeRef} />);

    await userEvent.click(screen.getByRole("button", { name: "script.py:41" }));
    expect(onOpenCodeRef).toHaveBeenCalledExactlyOnceWith(41);
  });

  it("code_ref degrades to plain text when no navigation is wired (never a fake link)", () => {
    render(<FindingsTab findings={MANIFEST} />);
    expect(screen.queryByRole("button", { name: "script.py:41" })).toBeNull();
    expect(screen.getByText("script.py:41")).toBeTruthy();
  });

  it("legacy runs (no manifest) explain WHY, never an empty state (spec §6, review P11)", () => {
    render(<FindingsTab findings={undefined} />);
    expect(screen.getByText("No manifest (pre-2026-08 analysis)")).toBeTruthy();
  });

  it("a run that declared nothing says so", () => {
    render(<FindingsTab findings={{ manifest_version: "1.0", findings: [] }} />);
    expect(screen.getByText("No findings were declared in this run.")).toBeTruthy();
  });

  it("shows the §6 trust disclosure and no unqualified 'verified' anywhere", () => {
    const { container } = render(<FindingsTab findings={MANIFEST} />);
    expect(
      screen.getByText(
        /Structurally checked — definitions and values are produced by the analysis code \(not reviewed for truth\)\./
      )
    ).toBeTruthy();
    // Anti-laundering rule (spec §6): the word "verified" must not appear
    // anywhere on the findings surface, next to entries or otherwise.
    expect(container.textContent).not.toMatch(/verified/i);
  });
});

describe("parseCodeRefLine", () => {
  it("parses valid refs and rejects malformed ones", () => {
    expect(parseCodeRefLine("script.py:41")).toBe(41);
    expect(parseCodeRefLine("script.py")).toBeNull();
    expect(parseCodeRefLine("script.py:0")).toBeNull();
    expect(parseCodeRefLine("script.py:abc")).toBeNull();
  });
});

describe("grounding advisories", () => {
  const REPORT: GroundingReport = {
    ok: false,
    checkedCount: 3,
    ungrounded: ["42%"],
    contradictions: ["narrative asserts a rising trend but the computed trend result says falling"],
    unnarratedFindings: ["august_step", "churn_by_cohort"],
    questionPrimaryMiss: "median_revenue",
    findingIssues: ["derivation contradiction: net_margin derives from a dropped finding"],
    citedSteps: [1],
    uncitedSuccessfulSteps: [],
  };

  it("InvestigationCaveats renders contradictions and un-narrated finding names", () => {
    const spec = { root: "r", elements: {}, state: { __grounding: REPORT } };
    render(<InvestigationCaveats spec={spec as never} />);

    expect(
      screen.getByText(/rising trend but the computed trend result says falling/)
    ).toBeTruthy();
    expect(
      screen.getByText(/Computed but not mentioned: august_step, churn_by_cohort\./)
    ).toBeTruthy();
    expect(screen.getByText(/\(median_revenue\) is not shown in a headline stat/)).toBeTruthy();
    expect(screen.getByText(/Findings check: derivation contradiction/)).toBeTruthy();
  });

  it("renders nothing for reports that predate the advisory fields", () => {
    const legacy: GroundingReport = {
      ok: true,
      checkedCount: 5,
      ungrounded: [],
      citedSteps: [],
      uncitedSuccessfulSteps: [],
    };
    const { container } = render(<GroundingAdvisories grounding={legacy} />);
    expect(container.firstChild).toBeNull();
  });
});

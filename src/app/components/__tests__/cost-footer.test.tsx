// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { CostFooter } from "@/app/components/cost-footer";
import { RAIL_COLLAPSED_WIDTH } from "@/app/components/data-rail";

afterEach(cleanup);

function renderFooter() {
  render(
    <CostFooter
      lastCost={{
        costUsd: 1.11,
        llmCalls: 12,
        inputTokens: 40_000,
        outputTokens: 9_000,
        cacheReadTokens: 120_000,
      }}
      sessionCostUsd={1.11}
    />
  );
  return screen.getByRole("status");
}

describe("CostFooter", () => {
  it("clears the collapsed data rail instead of sitting flush right", () => {
    // The rail is fixed to the right edge at z-index 180 vs the footer's 120,
    // so a footer at right:0 is painted over and "Cost & usage" is cut off.
    const footer = renderFooter();

    expect(footer.style.right).not.toBe("");
    expect(footer.style.right).not.toBe("0px");
    expect(parseInt(footer.style.right, 10)).toBeGreaterThanOrEqual(RAIL_COLLAPSED_WIDTH);
    // A Tailwind right-* class would win over nothing and silently re-flush it.
    expect(footer.className).not.toMatch(/\bright-/);
  });

  it("still renders both costs and the usage link", () => {
    const footer = renderFooter();

    expect(footer.textContent).toContain("Last: $1.11");
    expect(footer.textContent).toContain("Session: $1.11");
    expect(screen.getByRole("link", { name: /cost/i })).toHaveAttribute("href", "/cost");
  });
});

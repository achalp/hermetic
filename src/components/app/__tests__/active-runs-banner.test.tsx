// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActiveRunsBanner, elapsedLabel } from "@/components/app/active-runs-banner";
import type { ActiveRun } from "@/app/lib/api";

afterEach(() => cleanup());

const run = (over: Partial<ActiveRun> = {}): ActiveRun => ({
  runId: "r1",
  csvId: "csv-1",
  question: "which building is farthest",
  route: "/api/query",
  startedAt: 1_000,
  ...over,
});

describe("elapsedLabel", () => {
  it("formats seconds under a minute and minutes above", () => {
    expect(elapsedLabel(0, 45_000)).toBe("45s");
    expect(elapsedLabel(0, 12 * 60_000)).toBe("12m");
    expect(elapsedLabel(5_000, 4_000)).toBe("0s"); // clamps negative
  });
});

describe("ActiveRunsBanner", () => {
  it("renders nothing when there are no runs", () => {
    const { container } = render(
      <ActiveRunsBanner runs={[]} onResume={vi.fn()} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("hides runs with no source (nothing to restore)", () => {
    const { container } = render(
      <ActiveRunsBanner runs={[run({ csvId: undefined })]} onResume={vi.fn()} onDismiss={vi.fn()} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the question and elapsed time, and fires Resume with the run", async () => {
    const onResume = vi.fn();
    render(
      <ActiveRunsBanner
        runs={[run({ startedAt: 0 })]}
        now={3 * 60_000}
        onResume={onResume}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText("which building is farthest")).toBeTruthy();
    expect(screen.getByText(/3m elapsed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledWith(run({ startedAt: 0 }));
  });

  it("fires onDismiss with the runId", async () => {
    const onDismiss = vi.fn();
    render(<ActiveRunsBanner runs={[run()]} onResume={vi.fn()} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("r1");
  });
});

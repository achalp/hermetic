import { describe, it, expect } from "vitest";
import * as compose from "@/lib/pipeline/dashboard-compose";

/**
 * Guards the L7 split that moved the prompt-assembly cluster into
 * dashboard-compose-prompt.ts: dashboard-compose.ts must keep re-exporting the
 * public surface its four consumers (run-ask-query, run-investigate-query,
 * controller, prompt-fragments) import, so a dropped re-export fails here
 * rather than at a call site.
 */
describe("dashboard-compose public surface (L7 split)", () => {
  it("re-exports the orchestration + prompt-builder functions", () => {
    for (const name of [
      "composeAndStreamDashboard",
      "buildDashboardComposeRequest",
      "buildValuesSection",
      "mirroredResultKeys",
    ]) {
      expect(typeof (compose as Record<string, unknown>)[name], name).toBe("function");
    }
  });

  it("re-exports the row-cap and values-size constants", () => {
    expect((compose as Record<string, unknown>).INTERACTIVE_ROW_CAP).toBe(5000);
    expect(typeof (compose as Record<string, unknown>).VALUES_SECTION_MAX_BYTES).toBe("number");
  });
});

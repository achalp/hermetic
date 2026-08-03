// @vitest-environment jsdom
//
// End-to-end dispatch test for chart drill-down. The bug this guards against:
// the custom `drillDown` action was never registered because response-panel
// rendered a bare <ActionProvider> instead of passing the registry's handlers.
// So every chart emit("click") hit "No handler registered for action: drillDown"
// and silently no-op'd.
//
// This drives the SAME path a chart's emit uses internally — json-render's
// ElementRenderer does `const { execute } = useActions(); ... execute(binding)`
// (index.mjs) — so dispatching via useActions().execute through the real
// <ActionProvider handlers={registryActionHandlers}> exercises the actual
// registration + dispatch + handler + callback chain without depending on Nivo
// SVG layout or chart data plumbing.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ActionProvider, StateProvider, useActions } from "@json-render/react";
import { registryActionHandlers, makeRegistryActionHandlers } from "@/components/registry";
import type { DrillDownParams } from "@/lib/contracts/spec-types";

// The on.click binding the investigate composer emits for a region bar chart:
// filter_value is an $item binding (resolves to undefined outside a repeat
// scope — the ResponsePanel callback recovers the real value from the click
// record); filter_column is a plain string that survives.
const drillBinding = {
  action: "drillDown",
  params: {
    filter_column: "region",
    filter_value: { $item: "region" },
    segment_label: "Region",
    segment_value: { $item: "region" },
    chart_title: "Total Revenue by Region",
    x_key: "region",
    y_key: "total_revenue",
  },
};

function Dispatcher() {
  const { execute } = useActions();
  return (
    <button data-testid="go" onClick={() => execute(drillBinding as Parameters<typeof execute>[0])}>
      go
    </button>
  );
}

afterEach(() => {
  cleanup();
});

describe("chart drill-down action dispatch", () => {
  it("registers a drillDown handler in the registry handlers", () => {
    expect(typeof registryActionHandlers.drillDown).toBe("function");
  });

  it("dispatching drillDown reaches the wired dispatch (makeRegistryActionHandlers)", async () => {
    const received: DrillDownParams[] = [];
    render(
      <StateProvider initialState={{}}>
        <ActionProvider handlers={makeRegistryActionHandlers((p) => received.push(p))}>
          <Dispatcher />
        </ActionProvider>
      </StateProvider>
    );

    await userEvent.click(screen.getByTestId("go"));
    await waitFor(() => expect(received.length).toBe(1));

    expect(received[0].filter_column).toBe("region");
  });

  it("does NOT reach the callback with a bare ActionProvider (the original bug)", async () => {
    const received: DrillDownParams[] = [];
    void received;
    render(
      <StateProvider initialState={{}}>
        <ActionProvider>
          <Dispatcher />
        </ActionProvider>
      </StateProvider>
    );

    await userEvent.click(screen.getByTestId("go"));

    expect(received.length).toBe(0);
  });
});

// M5-5b regression: with the old module-level drillDownCallbackRef, a second
// mounted panel overwrote the first's callback (and unmount nulled it for
// both). Two SpecView-wired handler sets must route independently.
describe("two mounted panels (M5-5b)", () => {
  it("each panel's dispatch receives only its own drills", async () => {
    const a: DrillDownParams[] = [];
    const b: DrillDownParams[] = [];
    render(
      <>
        <StateProvider initialState={{}}>
          <ActionProvider handlers={makeRegistryActionHandlers((p) => a.push(p))}>
            <Dispatcher />
          </ActionProvider>
        </StateProvider>
        <StateProvider initialState={{}}>
          <ActionProvider handlers={makeRegistryActionHandlers((p) => b.push(p))}>
            <Dispatcher />
          </ActionProvider>
        </StateProvider>
      </>
    );
    const buttons = screen.getAllByTestId("go");
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]);
    await waitFor(() => expect(a.length).toBe(1));
    expect(b.length).toBe(0);
    await userEvent.click(buttons[1]);
    await waitFor(() => expect(b.length).toBe(1));
    expect(a.length).toBe(1);
  });
});

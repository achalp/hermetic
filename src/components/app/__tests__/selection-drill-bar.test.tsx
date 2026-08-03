// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { StateProvider } from "@/spec/react";
import { SelectionDrillBar } from "@/components/app/selection-drill-bar";
import { DrillDownDispatchContext } from "@/lib/drill-down-context";
import type { DrillDownParams } from "@/lib/contracts/spec-types";

let dispatched: DrillDownParams[] = [];

function renderBar(filters: Record<string, unknown>) {
  return render(
    <DrillDownDispatchContext.Provider value={(p) => dispatched.push(p)}>
      <StateProvider initialState={{ filters }}>
        <SelectionDrillBar />
      </StateProvider>
    </DrillDownDispatchContext.Provider>
  );
}

beforeEach(() => {
  dispatched = [];
});
afterEach(() => {
  cleanup();
});

describe("SelectionDrillBar", () => {
  it("renders nothing when there is no active selection", () => {
    renderBar({ region: "All", channel: "" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when /filters is absent", () => {
    render(
      <StateProvider initialState={{}}>
        <SelectionDrillBar />
      </StateProvider>
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the active selections (excluding 'All') and their description", () => {
    renderBar({ region: "West", channel: "Online", quarter: "All" });
    expect(screen.getByText(/region = West/)).toBeTruthy();
    expect(screen.getByText(/channel = Online/)).toBeTruthy();
    expect(screen.queryByText(/quarter/)).toBeNull();
  });

  it("builds DrillDownParams (primary + additional_filters) and invokes the callback", async () => {
    const received = dispatched;

    renderBar({ region: "West", channel: "Online", quarter: "All" });
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(received.length).toBe(1));

    const p = received[0];
    expect(p.filter_column).toBe("region");
    expect(p.filter_value).toBe("West");
    expect(p.additional_filters).toEqual([{ column: "channel", value: "Online" }]);
    expect(p.segment_label).toBe("West · Online");
  });

  it("omits additional_filters for a single selection", async () => {
    const received = dispatched;

    renderBar({ region: "West" });
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(received.length).toBe(1));

    expect(received[0].filter_column).toBe("region");
    expect(received[0].additional_filters).toBeNull();
  });

  it("clears the selection after dispatching (bar disappears)", async () => {
    renderBar({ region: "West" });
    const btn = screen.getByRole("button");
    await userEvent.click(btn);
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });

  it("supports a multi-select (array) on one dimension as column IN (...)", async () => {
    const received = dispatched;

    renderBar({ region: ["North", "East"] });
    expect(screen.getByText(/region in \(North, East\)/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(received.length).toBe(1));

    expect(received[0].filter_column).toBe("region");
    expect(received[0].filter_value).toEqual(["North", "East"]);
    expect(received[0].segment_label).toBe("North, East");
  });

  it("treats an empty-array selection as no selection (hidden)", () => {
    renderBar({ region: [] });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("preserves numeric selection values", async () => {
    const received = dispatched;

    renderBar({ year: 2025 });
    await userEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(received.length).toBe(1));

    expect(received[0].filter_value).toBe(2025);
    expect(received[0].segment_label).toBe("2025");
  });
});

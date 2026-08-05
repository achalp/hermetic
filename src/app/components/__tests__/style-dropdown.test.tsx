// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StyleDropdown } from "@/app/components/style-dropdown";

afterEach(cleanup);

describe("StyleDropdown", () => {
  it("shows the current mode as the trigger and opens the list on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StyleDropdown selected="brief" onSelect={onSelect} />);

    const trigger = screen.getByRole("button", { name: /Brief/ });
    expect(trigger.textContent).toContain("Brief");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // all four styles listed
    expect(screen.getByRole("option", { name: /Dashboard/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Deep dive/ })).toBeInTheDocument();
  });

  it("resolves a legacy id to the current mode label", () => {
    render(<StyleDropdown selected="infographic" onSelect={() => {}} />);
    expect(screen.getByRole("button").textContent).toContain("Dashboard");
  });

  it("selecting a different style fires onSelect and closes; re-selecting current does nothing", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StyleDropdown selected="dashboard" onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Dashboard/ }));
    await user.click(screen.getByRole("option", { name: /Report/ }));
    expect(onSelect).toHaveBeenCalledWith("report");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    // Re-open and pick the already-active one — no redundant re-run.
    await user.click(screen.getByRole("button", { name: /Dashboard/ }));
    await user.click(screen.getByRole("option", { name: /Dashboard/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

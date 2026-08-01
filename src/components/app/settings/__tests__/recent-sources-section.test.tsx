// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import type { RecentSourceInfo } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  getRecentSources: vi.fn(),
  removeRecentSource: vi.fn().mockResolvedValue(undefined),
  renameRecentSource: vi.fn().mockResolvedValue(undefined),
  clearRecentSources: vi.fn().mockResolvedValue(undefined),
}));

import {
  getRecentSources,
  removeRecentSource,
  renameRecentSource,
  clearRecentSources,
} from "@/lib/api";
import {
  RecentSourcesSection,
  RECENTS_CHANGED_EVENT,
} from "@/components/app/settings/recent-sources-section";

const RECENTS: RecentSourceInfo[] = [
  {
    id: "r1",
    kind: "upload",
    name: "quarterly_deals.xlsx",
    subtitle: "~/…",
    lastUsedAt: new Date().toISOString(),
    useCount: 3,
  },
  {
    id: "r2",
    kind: "remote-parquet",
    name: "acme-lake/events",
    subtitle: "s3://…",
    lastUsedAt: new Date().toISOString(),
    useCount: 1,
  },
];

beforeEach(() => {
  vi.mocked(getRecentSources).mockResolvedValue([...RECENTS]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RecentSourcesSection", () => {
  it("lists recents with kind labels", async () => {
    render(<RecentSourcesSection />);
    expect(await screen.findByText("quarterly_deals.xlsx")).toBeTruthy();
    expect(screen.getByText(/upload · /)).toBeTruthy();
    expect(screen.getByText(/cloud · /)).toBeTruthy();
  });

  it("shows an empty state when there are no recents", async () => {
    vi.mocked(getRecentSources).mockResolvedValue([]);
    render(<RecentSourcesSection />);
    expect(await screen.findByText("No recent files or cloud sources.")).toBeTruthy();
    expect(screen.queryByText("Clear all")).toBeNull();
  });

  it("remove calls the API, refetches, and broadcasts the change event", async () => {
    const changed = vi.fn();
    window.addEventListener(RECENTS_CHANGED_EVENT, changed);
    render(<RecentSourcesSection />);
    await screen.findByText("quarterly_deals.xlsx");

    await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(removeRecentSource).toHaveBeenCalledExactlyOnceWith("r1"));
    expect(getRecentSources).toHaveBeenCalledTimes(2); // mount + after remove
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(RECENTS_CHANGED_EVENT, changed);
  });

  it("rename flow: edit, save enabled only when changed, calls the API", async () => {
    render(<RecentSourcesSection />);
    await screen.findByText("quarterly_deals.xlsx");

    await userEvent.click(screen.getAllByRole("button", { name: "Rename" })[0]);
    const input = screen.getByLabelText("New name for quarterly_deals.xlsx");
    const save = screen.getByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true); // unchanged name

    await userEvent.clear(input);
    await userEvent.type(input, "Q2 deals");
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(save);
    await waitFor(() =>
      expect(renameRecentSource).toHaveBeenCalledExactlyOnceWith("r1", "Q2 deals")
    );
  });

  it("clear all calls the API and broadcasts", async () => {
    const changed = vi.fn();
    window.addEventListener(RECENTS_CHANGED_EVENT, changed);
    render(<RecentSourcesSection />);
    await screen.findByText("quarterly_deals.xlsx");

    await userEvent.click(screen.getByRole("button", { name: "Clear all" }));
    await waitFor(() => expect(clearRecentSources).toHaveBeenCalledTimes(1));
    expect(changed).toHaveBeenCalledTimes(1);
    window.removeEventListener(RECENTS_CHANGED_EVENT, changed);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { AddDataMenu, type SavedConnectionItem } from "@/app/components/home/add-data-menu";
import type { RecentItem } from "@/app/components/recent-sources";

afterEach(() => cleanup());

const RECENTS: RecentItem[] = [
  { id: "r1", kind: "upload", name: "quarterly_deals.xlsx", subtitle: "~", meta: "2h ago" },
  { id: "r2", kind: "warehouse", name: "play.clickhouse.com", subtitle: "ch", brandColor: "#fc0" },
  { id: "r3", kind: "remote-parquet", name: "acme-lake/events", subtitle: "s3" },
  { id: "r4", kind: "upload", name: "should-not-render.csv", subtitle: "~" },
];

const SAVED: SavedConnectionItem[] = [
  { id: "s1", name: "play.clickhouse.com / default", brandColor: "#fc0" },
  { id: "s2", name: "bigquery-public-data.stackoverflow" },
];

function renderMenu(overrides: Partial<React.ComponentProps<typeof AddDataMenu>> = {}) {
  const handlers = {
    recents: RECENTS,
    savedConnections: SAVED,
    onOpenRecent: vi.fn(),
    onUpload: vi.fn(),
    onLocalBrowse: vi.fn(),
    onNewWarehouse: vi.fn(),
    onSavedConnect: vi.fn(),
    onSample: vi.fn(),
    onPicked: vi.fn(),
    ...overrides,
  };
  render(<AddDataMenu {...handlers} />);
  return handlers;
}

describe("AddDataMenu", () => {
  it("shows at most three recents, newest first", () => {
    renderMenu();
    expect(screen.getByText("quarterly_deals.xlsx")).toBeTruthy();
    expect(screen.getByText("acme-lake/events")).toBeTruthy();
    expect(screen.queryByText("should-not-render.csv")).toBeNull();
  });

  it("hides the Recent group entirely for first-run users", () => {
    renderMenu({ recents: [] });
    expect(screen.queryByText("Recent")).toBeNull();
    // The four add-new actions are still present.
    expect(screen.getByText("Upload a file")).toBeTruthy();
    expect(screen.getByText("Use the sample dataset")).toBeTruthy();
  });

  it("nests saved connections in their own group under the warehouse entry", () => {
    renderMenu();
    const saved = screen.getByRole("group", { name: "Saved connections" });
    expect(within(saved).getByText("play.clickhouse.com / default")).toBeTruthy();
    expect(within(saved).getByText("bigquery-public-data.stackoverflow")).toBeTruthy();
  });

  it("omits the saved group when there are no saved connections", () => {
    renderMenu({ savedConnections: [] });
    expect(screen.queryByRole("group", { name: "Saved connections" })).toBeNull();
  });

  it("opening a recent reports the item and closes the menu", async () => {
    const h = renderMenu();
    await userEvent.click(screen.getByText("quarterly_deals.xlsx"));
    expect(h.onOpenRecent).toHaveBeenCalledExactlyOnceWith(RECENTS[0]);
    expect(h.onPicked).toHaveBeenCalledTimes(1);
  });

  it("each action fires its callback and closes", async () => {
    const h = renderMenu();
    await userEvent.click(screen.getByText("Upload a file"));
    expect(h.onUpload).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText("Local & cloud files"));
    expect(h.onLocalBrowse).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText("Connect a warehouse"));
    expect(h.onNewWarehouse).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText("bigquery-public-data.stackoverflow"));
    expect(h.onSavedConnect).toHaveBeenCalledExactlyOnceWith("s2");
    await userEvent.click(screen.getByText("Use the sample dataset"));
    expect(h.onSample).toHaveBeenCalledTimes(1);
    expect(h.onPicked).toHaveBeenCalledTimes(5);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { RecentSources, type RecentItem } from "@/app/components/recent-sources";

afterEach(cleanup);

const ITEMS: RecentItem[] = [
  {
    id: "1",
    kind: "warehouse",
    name: "Prod BQ",
    subtitle: "bigquery://proj",
    meta: "2h ago",
    brandColor: "#4285F4",
  },
  {
    id: "2",
    kind: "remote-parquet",
    name: "Overture",
    subtitle: "s3://overture/theme=buildings/very/long/path/that/exceeds/the/limit/for/sure/indeed",
    meta: "2.5B rows",
  },
  { id: "3", kind: "local-file", name: "sales.csv", subtitle: "/data/sales.csv" },
  { id: "4", kind: "upload", name: "upload.csv", subtitle: "uploaded.csv" },
];

const baseProps = {
  onOpen: vi.fn(),
  onRefresh: vi.fn(),
  onRemove: vi.fn(),
  onRename: vi.fn(),
  onClearAll: vi.fn(),
};

describe("RecentSources", () => {
  it("renders nothing when there are no items", () => {
    const { container } = render(<RecentSources {...baseProps} items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists items with names and middle-truncated subtitles", () => {
    render(<RecentSources {...baseProps} items={ITEMS} />);
    expect(screen.getByText("Recent")).toBeInTheDocument();
    expect(screen.getByText("Prod BQ")).toBeInTheDocument();
    expect(screen.getByText("Overture")).toBeInTheDocument();
    // Long subtitle gets an ellipsis in the middle
    expect(screen.getByText(/…/)).toBeInTheDocument();
  });

  it("opens an item on click", () => {
    const onOpen = vi.fn();
    render(<RecentSources {...baseProps} items={ITEMS} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Prod BQ"));
    expect(onOpen).toHaveBeenCalledWith(ITEMS[0]);
  });

  it("refreshes a refreshable source and removes items", () => {
    const onRefresh = vi.fn();
    const onRemove = vi.fn();
    render(
      <RecentSources {...baseProps} items={ITEMS} onRefresh={onRefresh} onRemove={onRemove} />
    );
    // Refresh shown only for refreshable kinds (remote-parquet / local-file / -folder)
    fireEvent.click(screen.getAllByLabelText("Refresh schema")[0]);
    expect(onRefresh).toHaveBeenCalled();
    fireEvent.click(screen.getAllByLabelText("Remove")[0]);
    expect(onRemove).toHaveBeenCalled();
  });

  it("renames via double-click then Enter", () => {
    const onRename = vi.fn();
    render(<RecentSources {...baseProps} items={ITEMS} onRename={onRename} />);
    fireEvent.doubleClick(screen.getByText("sales.csv"));
    const input = screen.getByDisplayValue("sales.csv");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith(ITEMS[2], "Renamed");
  });

  it("clears all", () => {
    const onClearAll = vi.fn();
    render(<RecentSources {...baseProps} items={ITEMS} onClearAll={onClearAll} />);
    fireEvent.click(screen.getByText("Clear all"));
    expect(onClearAll).toHaveBeenCalled();
  });
});

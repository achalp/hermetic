// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { RecentSourcesSection } from "@/app/components/settings/recent-sources-section";

const api = vi.hoisted(() => ({
  getRecentSources: vi.fn(),
  removeRecentSource: vi.fn(async () => undefined),
  renameRecentSource: vi.fn(async () => undefined),
  clearRecentSources: vi.fn(async () => undefined),
}));

vi.mock("@/app/lib/api", () => api);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SOURCES = [
  { id: "a", kind: "local-file", name: "sales.csv", lastUsedAt: Date.now() - 3600_000 },
  { id: "b", kind: "remote-parquet", name: "overture", lastUsedAt: Date.now() - 7200_000 },
];

describe("RecentSourcesSection", () => {
  it("shows an empty state when there are no recents", async () => {
    api.getRecentSources.mockResolvedValue([]);
    render(<RecentSourcesSection />);
    await waitFor(() =>
      expect(screen.getByText("No recent files or cloud sources.")).toBeInTheDocument()
    );
  });

  it("lists recents and removes one", async () => {
    api.getRecentSources.mockResolvedValue(SOURCES);
    render(<RecentSourcesSection />);
    expect(await screen.findByText("sales.csv")).toBeInTheDocument();
    expect(screen.getByText("overture")).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Remove")[0]);
    await waitFor(() => expect(api.removeRecentSource).toHaveBeenCalledWith("a"));
  });

  it("renames a recent source", async () => {
    api.getRecentSources.mockResolvedValue(SOURCES);
    render(<RecentSourcesSection />);
    await screen.findByText("sales.csv");
    fireEvent.click(screen.getAllByText("Rename")[0]);
    const input = screen.getByPlaceholderText("sales.csv");
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(api.renameRecentSource).toHaveBeenCalledWith("a", "New name"));
  });

  it("clears all recents", async () => {
    api.getRecentSources.mockResolvedValue(SOURCES);
    render(<RecentSourcesSection />);
    await screen.findByText("sales.csv");
    fireEvent.click(screen.getByText("Clear all"));
    await waitFor(() => expect(api.clearRecentSources).toHaveBeenCalled());
  });
});

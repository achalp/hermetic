// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useRecentsList } from "@/hooks/use-recents-list";
import { RECENTS_CHANGED_EVENT } from "@/lib/constants";

vi.mock("@/app/lib/api", () => ({
  getRecentSources: vi.fn(),
}));

import { getRecentSources } from "@/app/lib/api";
const mGetRecents = getRecentSources as ReturnType<typeof vi.fn>;

const recentSources = [
  {
    id: "r1",
    kind: "local-file",
    name: "sales.csv",
    subtitle: "~/data",
    rows: 2_500_000,
    lastUsedAt: "2026-01-02T00:00:00Z",
    path: "/data/sales.csv",
  },
];

function makeWarehouse(over = {}) {
  return {
    savedConnections: [
      {
        id: "wh1",
        label: "PG",
        name: "My PG",
        createdAt: "2026-01-01T00:00:00Z",
        config: { type: "postgres", host: "db" },
      },
    ],
    connect: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

beforeEach(() => {
  mGetRecents.mockReset().mockResolvedValue(recentSources);
});

afterEach(() => cleanup());

describe("useRecentsList", () => {
  it("loads and merges recent files + warehouses into one sorted list", async () => {
    const { result } = renderHook(() =>
      useRecentsList({
        warehouse: makeWarehouse(),
        handleRemoteFileSelect: vi.fn(),
        handleLocalFileSelect: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.recentItems.length).toBe(2));
    // sales.csv (2026-01-02) sorts before the warehouse (2026-01-01)
    expect(result.current.recentItems[0].name).toBe("sales.csv");
    // Row count formatted compactly.
    expect(result.current.recentItems[0].meta).toContain("2.5M rows");
    const wh = result.current.recentItems.find((i) => i.kind === "warehouse");
    expect(wh?.name).toBe("My PG");
  });

  it("refetches on the RECENTS_CHANGED_EVENT", async () => {
    renderHook(() =>
      useRecentsList({
        warehouse: makeWarehouse(),
        handleRemoteFileSelect: vi.fn(),
        handleLocalFileSelect: vi.fn(),
      })
    );
    await waitFor(() => expect(mGetRecents).toHaveBeenCalledTimes(1));
    act(() => {
      window.dispatchEvent(new Event(RECENTS_CHANGED_EVENT));
    });
    await waitFor(() => expect(mGetRecents).toHaveBeenCalledTimes(2));
  });

  it("reopenRecent routes a warehouse item back through warehouse.connect", async () => {
    const warehouse = makeWarehouse();
    const { result } = renderHook(() =>
      useRecentsList({
        warehouse,
        handleRemoteFileSelect: vi.fn(),
        handleLocalFileSelect: vi.fn(),
      })
    );
    await waitFor(() => expect(result.current.recentItems.length).toBe(2));
    const whItem = result.current.recentItems.find((i) => i.kind === "warehouse")!;
    await act(async () => {
      await result.current.reopenRecent(whItem);
    });
    expect(
      (warehouse as unknown as { connect: ReturnType<typeof vi.fn> }).connect
    ).toHaveBeenCalledWith({ type: "postgres", host: "db" }, false);
  });

  it("reopenRecent routes a local file back through handleLocalFileSelect", async () => {
    const handleLocalFileSelect = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useRecentsList({
        warehouse: makeWarehouse(),
        handleRemoteFileSelect: vi.fn(),
        handleLocalFileSelect,
      })
    );
    await waitFor(() => expect(result.current.recentItems.length).toBe(2));
    const fileItem = result.current.recentItems.find((i) => i.kind === "local-file")!;
    await act(async () => {
      await result.current.reopenRecent(fileItem);
    });
    expect(handleLocalFileSelect).toHaveBeenCalledWith("/data/sales.csv", "file");
  });
});

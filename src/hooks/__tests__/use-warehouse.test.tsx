// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useWarehouse } from "@/hooks/use-warehouse";

vi.mock("@/app/lib/api", () => ({
  connectWarehouse: vi.fn(),
  disconnectWarehouse: vi.fn(),
  getSavedConnections: vi.fn(),
  deleteSavedConnection: vi.fn(),
  renameSavedConnection: vi.fn(),
}));

import {
  connectWarehouse,
  disconnectWarehouse,
  getSavedConnections,
  deleteSavedConnection,
  renameSavedConnection,
} from "@/app/lib/api";

const mConnect = connectWarehouse as ReturnType<typeof vi.fn>;
const mDisconnect = disconnectWarehouse as ReturnType<typeof vi.fn>;
const mGetSaved = getSavedConnections as ReturnType<typeof vi.fn>;
const mDelete = deleteSavedConnection as ReturnType<typeof vi.fn>;
const mRename = renameSavedConnection as ReturnType<typeof vi.fn>;

const config = { type: "postgres", host: "db", label: "L" } as never;

const connectResult = {
  warehouse_id: "wh-1",
  tables: [{ name: "t1" }],
  table_schemas: [{ table: "t1", columns: [] }],
  table_count: 1,
  total_columns: 3,
};

beforeEach(() => {
  mConnect.mockReset().mockResolvedValue(connectResult);
  mDisconnect.mockReset().mockResolvedValue(undefined);
  mGetSaved
    .mockReset()
    .mockResolvedValue([{ id: "s1", label: "Saved", config: { type: "postgres" } }]);
  mDelete.mockReset().mockResolvedValue(undefined);
  mRename.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("useWarehouse", () => {
  it("loads saved connections on mount", async () => {
    const { result } = renderHook(() => useWarehouse());
    expect(result.current.isConnected).toBe(false);
    await waitFor(() => expect(result.current.savedConnections).toHaveLength(1));
  });

  it("connect populates warehouse state", async () => {
    const { result } = renderHook(() => useWarehouse());
    await act(async () => {
      await result.current.connect(config);
    });
    expect(result.current.warehouseId).toBe("wh-1");
    expect(result.current.isConnected).toBe(true);
    expect(result.current.isConnecting).toBe(false);
    expect(result.current.tableCount).toBe(1);
    expect(result.current.totalColumns).toBe(3);
    expect(result.current.error).toBeNull();
  });

  it("connect records an error on failure", async () => {
    mConnect.mockRejectedValueOnce(new Error("bad creds"));
    const { result } = renderHook(() => useWarehouse());
    await act(async () => {
      await result.current.connect(config);
    });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe("bad creds");
  });

  it("disconnect clears warehouse state", async () => {
    const { result } = renderHook(() => useWarehouse());
    await act(async () => {
      await result.current.connect(config);
    });
    await act(async () => {
      await result.current.disconnect();
    });
    expect(mDisconnect).toHaveBeenCalledWith("wh-1");
    expect(result.current.warehouseId).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it("deleteSaved removes a connection locally", async () => {
    const { result } = renderHook(() => useWarehouse());
    await waitFor(() => expect(result.current.savedConnections).toHaveLength(1));
    await act(async () => {
      await result.current.deleteSaved("s1");
    });
    expect(mDelete).toHaveBeenCalledWith("s1");
    expect(result.current.savedConnections).toHaveLength(0);
  });

  it("renameSaved optimistically updates the name", async () => {
    const { result } = renderHook(() => useWarehouse());
    await waitFor(() => expect(result.current.savedConnections).toHaveLength(1));
    await act(async () => {
      await result.current.renameSaved("s1", "New Name");
    });
    expect(mRename).toHaveBeenCalledWith("s1", "New Name");
    expect(result.current.savedConnections[0].name).toBe("New Name");
  });

  it("refresh re-connects the last config with force", async () => {
    const { result } = renderHook(() => useWarehouse());
    await act(async () => {
      await result.current.connect(config);
    });
    mConnect.mockClear();
    await act(async () => {
      await result.current.refresh();
    });
    expect(mConnect).toHaveBeenCalledWith(config, true);
  });

  it("reset clears state without requiring an active connection", async () => {
    const { result } = renderHook(() => useWarehouse());
    await act(async () => {
      await result.current.connect(config);
    });
    act(() => result.current.reset());
    expect(result.current.warehouseId).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });
});

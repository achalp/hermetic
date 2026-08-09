// @vitest-environment jsdom
/**
 * The edit panel's behavior hook: optimistic ordering, the undo stack over
 * restore_document, and failure resync (a failed write must snap the list
 * back to server truth — the settings-mirror rule applied to editing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { usePlanEdit } from "@/hooks/use-plan-edit";
import { getPlanSurface, patchPlan } from "@/app/lib/api";

vi.mock("@/app/lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/app/lib/api")>();
  return { ...mod, getPlanSurface: vi.fn(), patchPlan: vi.fn() };
});

const mockGet = getPlanSurface as ReturnType<typeof vi.fn>;
const mockPatch = patchPlan as ReturnType<typeof vi.fn>;

const SURFACE = {
  doc: {
    mode: "compiled",
    purpose: "deep-dive",
    plan: { nodes: [{ id: "n_a", op: "ANSWER", refs: ["t"] }] },
    overlay: {},
  },
  sections: [
    {
      id: "n_a",
      kind: "node",
      op: "ANSWER",
      label: "ANSWER: t",
      preview: "Answer.",
      hidden: false,
    },
    { id: "chart_x", kind: "view", label: "Chart: X", hidden: false },
    { id: "table_x", kind: "view", label: "Table: X", hidden: false },
  ],
  claims: [],
  views: [],
};

beforeEach(() => {
  mockGet.mockReset().mockResolvedValue(structuredClone(SURFACE));
  mockPatch.mockReset().mockResolvedValue({ spec: { root: "r", elements: {} }, plan: SURFACE.doc });
});

afterEach(() => cleanup());

const args = (onSpecUpdated = vi.fn()) => ({
  csvId: "c1",
  historyId: "h1",
  open: true,
  onSpecUpdated,
});

describe("usePlanEdit", () => {
  it("loads the surface and mirrors sections", async () => {
    const { result } = renderHook(() => usePlanEdit(args()));
    await act(async () => {});
    expect(result.current.loaded).toBe(true);
    expect(result.current.sections.map((s) => s.id)).toEqual(["n_a", "chart_x", "table_x"]);
    expect(mockGet).toHaveBeenCalledWith("c1", "h1");
  });

  it("reorder is optimistic, then persists a move mutation with the history id", async () => {
    const { result } = renderHook(() => usePlanEdit(args()));
    await act(async () => {});
    act(() => result.current.reorder("table_x", "n_a"));
    // Optimistic: the list moved BEFORE the server answered.
    expect(result.current.sections.map((s) => s.id)).toEqual(["table_x", "n_a", "chart_x"]);
    await act(async () => {});
    expect(mockPatch).toHaveBeenCalledWith(
      "c1",
      [{ kind: "move", id: "table_x", before: "n_a" }],
      "h1"
    );
    // Drop-at-end sends move without `before`.
    act(() => result.current.reorder("n_a", null));
    await act(async () => {});
    expect(mockPatch).toHaveBeenLastCalledWith("c1", [{ kind: "move", id: "n_a" }], "h1");
  });

  it("every edit arms undo; undo replays the snapshot via restore_document", async () => {
    const { result } = renderHook(() => usePlanEdit(args()));
    await act(async () => {});
    expect(result.current.canUndo).toBe(false);
    await act(async () => {
      result.current.toggleHidden("chart_x", false);
    });
    expect(result.current.canUndo).toBe(true);
    await act(async () => {
      await result.current.undo();
    });
    const lastCall = mockPatch.mock.calls.at(-1)!;
    expect(lastCall[1][0].kind).toBe("restore_document");
    expect(lastCall[1][0].plan.nodes[0].id).toBe("n_a");
    expect(result.current.canUndo).toBe(false); // undo itself is not undoable
  });

  it("a failed write surfaces a human error and resyncs from the server", async () => {
    const { result } = renderHook(() => usePlanEdit(args()));
    await act(async () => {});
    mockPatch.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      result.current.toggleHidden("chart_x", false);
    });
    expect(result.current.error).toBeTruthy();
    // Resync: the optimistic hidden flag reverted to server truth.
    expect(result.current.sections.find((s) => s.id === "chart_x")?.hidden).toBe(false);
    expect(result.current.canUndo).toBe(false); // nothing was applied
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

vi.mock("@/app/lib/api", () => ({
  getSuggestions: vi.fn(),
  getFollowUpSuggestions: vi.fn(async () => []),
  getArtifacts: vi.fn(async () => ({})),
}));

import { getSuggestions } from "@/app/lib/api";
import { useSuggestions, LLM_SUGGEST_TIMEOUT_MS } from "@/hooks/use-suggestions";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const mGet = getSuggestions as ReturnType<typeof vi.fn>;

const schema = {
  csv_id: "c1",
  row_count: 10,
  columns: [
    {
      name: "region",
      dtype: "object",
      meta: { type: "categorical", top_values: [{ value: "West" }] },
    },
    { name: "revenue", dtype: "float64", meta: { type: "numeric", min: 1, max: 9 } },
  ],
} as unknown as CSVSchema;

const args = {
  schema,
  warehouse: { isConnected: false, warehouseId: null, tableSchemas: [] },
  isAnalyzing: false,
  currentQuestion: null,
  lastCompleteSpec: null,
  effectiveCsvId: "c1",
  csvId: "c1",
};

beforeEach(() => {
  vi.useFakeTimers();
  mGet.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useSuggestions — heuristics at once, LLM upgrade whenever it lands", () => {
  it("shows heuristic suggestions while the LLM call is still pending", () => {
    mGet.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSuggestions(args));
    expect(result.current.suggestions.length).toBeGreaterThan(0);
  });

  it("keeps a slow (20s) LLM answer instead of aborting at 8s", async () => {
    let resolve!: (q: string[]) => void;
    mGet.mockReturnValue(new Promise<string[]>((r) => (resolve = r)));
    const { result } = renderHook(() => useSuggestions(args));
    await act(async () => {
      vi.advanceTimersByTime(20_000);
      resolve(["Which region grew fastest?"]);
    });
    expect(result.current.suggestions).toEqual(["Which region grew fastest?"]);
    expect(LLM_SUGGEST_TIMEOUT_MS).toBeGreaterThan(20_000);
  });
});

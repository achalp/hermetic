/**
 * Canonical CSV serializer tests. The escaping rules here back EVERY rows→CSV
 * call path (warehouse connectors, step-frames, scheduler auto-export) — the
 * per-call-site copies this replaced had each drifted on exactly the cases
 * below (unquoted headers, missing \r handling). Round-trips go through the
 * app's own parseCSV so "correct" means "survives our real read path".
 */
import { describe, it, expect } from "vitest";
import { csvValue, rowsToCsv } from "@/lib/csv/csv-util";
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

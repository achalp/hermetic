import { describe, it, expect } from "vitest";
import { parseCSV, toCSVText } from "../parser";

describe("parseCSV", () => {
  it("parses basic CSV with headers", () => {
    const csv = "Name,Age,City\nAlice,30,NYC\nBob,25,LA";
    const result = parseCSV(csv);

    expect(result.headers).toEqual(["Name", "Age", "City"]);
    expect(result.rowCount).toBe(2);
    expect(result.data[0]).toEqual({ Name: "Alice", Age: "30", City: "NYC" });
    expect(result.data[1]).toEqual({ Name: "Bob", Age: "25", City: "LA" });
  });

  it("trims header whitespace", () => {
    const csv = " Name , Age \nAlice,30";
    const result = parseCSV(csv);

    expect(result.headers).toEqual(["Name", "Age"]);
  });

  it("handles empty headers by generating column names", () => {
    const csv = "Name,,City\nAlice,30,NYC";
    const result = parseCSV(csv);

    expect(result.headers).toContain("column_2");
    expect(result.rowCount).toBe(1);
  });

  it("handles duplicate headers by appending suffix", () => {
    const csv = "Name,Name,City\nAlice,Bob,NYC";
    const result = parseCSV(csv);

    expect(result.headers[0]).toBe("Name");
    expect(result.headers[1]).toBe("Name_1");
    expect(result.headers[2]).toBe("City");
  });

  it("skips empty lines", () => {
    const csv = "A,B\n1,2\n\n3,4\n";
    const result = parseCSV(csv);

    expect(result.rowCount).toBe(2);
  });

  it("returns empty data for headers-only CSV", () => {
    const csv = "A,B,C";
    const result = parseCSV(csv);

    expect(result.headers).toEqual(["A", "B", "C"]);
    expect(result.rowCount).toBe(0);
  });

  it("handles quoted fields with commas", () => {
    const csv = 'Name,Description\nAlice,"Has a, comma"\nBob,Normal';
    const result = parseCSV(csv);

    expect(result.data[0].Description).toBe("Has a, comma");
  });
});

describe("toCSVText", () => {
  it("round-trips through parseCSV", () => {
    const original = "Name,Age\nAlice,30\nBob,25";
    const parsed = parseCSV(original);
    const text = toCSVText(parsed);
    const reparsed = parseCSV(text);

    expect(reparsed.headers).toEqual(parsed.headers);
    expect(reparsed.rowCount).toEqual(parsed.rowCount);
    expect(reparsed.data).toEqual(parsed.data);
  });
});

import { describe, it, expect } from "vitest";
import { cleanGeneratedCode, fixUpFilenames, fixReadCsvDelimiter } from "@/lib/llm/code-generation";

describe("cleanGeneratedCode", () => {
  it("extracts code from a ```python fenced block", () => {
    expect(cleanGeneratedCode("```python\nprint(1)\n```")).toBe("print(1)");
  });

  it("extracts code from a plain ``` fenced block, ignoring leading prose", () => {
    expect(cleanGeneratedCode("Here is code:\n```\nx=1\n```")).toBe("x=1");
  });

  it("leaves already-clean code unchanged (no fences)", () => {
    expect(cleanGeneratedCode("x = 1\ny = 2")).toBe("x = 1\ny = 2");
  });

  it("returns empty string for empty input", () => {
    expect(cleanGeneratedCode("")).toBe("");
  });

  it("trims surrounding whitespace around fences and inner code", () => {
    expect(cleanGeneratedCode("  ```python  \n  code\n  ```  ")).toBe("code");
  });

  it("strips chat-template tokens that local models leak", () => {
    // im_start strips the rest of its line; im_end is removed in place.
    const raw = "```python\nprint(1)<|im_end|>\n<|im_start|>assistant\nprint(2)\n```";
    expect(cleanGeneratedCode(raw)).toBe("print(1)\n\nprint(2)");
  });

  it("falls back to stripping leading/trailing fences when no full block matches", () => {
    // A single opening fence with no closing fence: the block regex does not
    // match, so the fallback slices the leading ```python token.
    expect(cleanGeneratedCode("```python\nonly opening")).toBe("only opening");
  });
});

describe("fixUpFilenames", () => {
  it("collapses a doubled .csv extension under /data/", () => {
    expect(fixUpFilenames('pd.read_csv("/data/sales.csv.csv")', "sales.csv")).toBe(
      'pd.read_csv("/data/input.csv")'
    );
  });

  it("rewrites the original filename path to /data/input.csv", () => {
    expect(fixUpFilenames('pd.read_csv("/data/sales.csv")', "sales.csv")).toBe(
      'pd.read_csv("/data/input.csv")'
    );
  });

  it("escapes regex-special characters in the original filename", () => {
    expect(fixUpFilenames('open("/data/a+b (1).csv")', "a+b (1).csv")).toBe(
      'open("/data/input.csv")'
    );
  });

  it("is a no-op when the filename is already input.csv", () => {
    const code = 'pd.read_csv("/data/input.csv")';
    expect(fixUpFilenames(code, "input.csv")).toBe(code);
  });

  it("is a no-op (aside from double-ext fix) when filename is empty", () => {
    const code = 'pd.read_csv("/data/input.csv")';
    expect(fixUpFilenames(code, "")).toBe(code);
  });
});

describe("fixReadCsvDelimiter", () => {
  it("adds an explicit delimiter to a bare read_csv call", () => {
    expect(fixReadCsvDelimiter("duckdb.sql(\"SELECT * FROM read_csv('/data/input.csv')\")")).toBe(
      "duckdb.sql(\"SELECT * FROM read_csv('/data/input.csv', delimiter=',')\")"
    );
  });

  it("leaves a read_csv call that already has a delimiter alone", () => {
    const code = "read_csv('/data/input.csv', delimiter=',')";
    expect(fixReadCsvDelimiter(code)).toBe(code);
  });

  it("leaves a read_csv call that already has a sep= argument alone", () => {
    const code = "read_csv('/data/input.csv', sep='\\t')";
    expect(fixReadCsvDelimiter(code)).toBe(code);
  });
});

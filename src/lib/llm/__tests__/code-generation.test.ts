import { describe, it, expect } from "vitest";
import {
  cleanGeneratedCode,
  fixUpFilenames,
  fixExcelReadOnCsv,
  fixReadCsvDelimiter,
  stripValueAssertions,
} from "@/lib/llm/code-generation";

describe("stripValueAssertions", () => {
  it("removes a hard-coded value assertion (the reported crash)", () => {
    const out = stripValueAssertions(
      'assert corr.loc["revenue", "units"] == 0.785, "Correlation not found"'
    );
    expect(out).toContain("pass");
    expect(out).not.toContain("0.785");
  });

  it("removes integer-equality assertions too", () => {
    expect(stripValueAssertions('assert df["x"].sum() == 1000')).toContain("pass");
    expect(stripValueAssertions("assert n == -5")).toContain("pass");
  });

  it("preserves indentation so the block stays valid", () => {
    const code = "if True:\n    assert x == 0.5\n    y = 1";
    const out = stripValueAssertions(code);
    expect(out).toBe("if True:\n    pass  # removed hard-coded value assertion\n    y = 1");
  });

  it("keeps structural asserts that don't hard-code a value", () => {
    expect(stripValueAssertions("assert len(df) > 0")).toBe("assert len(df) > 0");
    expect(stripValueAssertions("assert not df.empty")).toBe("assert not df.empty");
  });

  it("keeps asserts comparing against a variable (not a literal)", () => {
    expect(stripValueAssertions("assert total == expected")).toBe("assert total == expected");
  });

  it("leaves code without asserts unchanged", () => {
    const code = "df = pd.read_csv('/data/input.csv')\nresult = df['x'].mean()";
    expect(stripValueAssertions(code)).toBe(code);
  });
});

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

describe("fixExcelReadOnCsv", () => {
  it("rewrites read_excel on the CSV input to read_csv (the reported crash)", () => {
    expect(fixExcelReadOnCsv('df = pd.read_excel("/data/input.csv")')).toBe(
      'df = pd.read_csv("/data/input.csv")'
    );
  });

  it("drops Excel-only kwargs like engine=openpyxl", () => {
    expect(fixExcelReadOnCsv('pd.read_excel("/data/input.csv", engine="openpyxl")')).toBe(
      'pd.read_csv("/data/input.csv")'
    );
    expect(fixExcelReadOnCsv("pd.read_excel('/data/input.csv', sheet_name=0)")).toBe(
      "pd.read_csv('/data/input.csv')"
    );
  });

  it("preserves a non-pd prefix (e.g. pandas.read_excel)", () => {
    expect(fixExcelReadOnCsv('pandas.read_excel("/data/input.csv")')).toBe(
      'pandas.read_csv("/data/input.csv")'
    );
  });

  it("leaves a genuine .xlsx read untouched (path is not a .csv)", () => {
    const code = 'pd.read_excel("/data/report.xlsx")';
    expect(fixExcelReadOnCsv(code)).toBe(code);
  });

  it("leaves an existing read_csv call unchanged", () => {
    const code = 'pd.read_csv("/data/input.csv")';
    expect(fixExcelReadOnCsv(code)).toBe(code);
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

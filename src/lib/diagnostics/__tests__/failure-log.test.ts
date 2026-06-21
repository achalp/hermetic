import { describe, it, expect } from "vitest";
import { classifyFailure } from "@/lib/diagnostics/failure-log";

describe("classifyFailure", () => {
  it("separates infra failures from code failures", () => {
    expect(
      classifyFailure("execution", "Your credit balance is too low to access the Anthropic API")
        .errorClass
    ).toBe("infra_no_credits");
    expect(
      classifyFailure("execution", "Local LLM request failed: fetch failed (Headers Timeout Error)")
        .errorClass
    ).toBe("infra_llm");
  });

  it("classifies warehouse SQL failures", () => {
    expect(
      classifyFailure("execution", "SQL execution failed: Timeout exceeded: elapsed 60014 ms")
        .errorClass
    ).toBe("sql_exec");
    expect(classifyFailure("execution", "SQL execution failed: socket hang up").detail).toBe(
      "hangup"
    );
  });

  it("extracts the Python exception class and failing op from a traceback", () => {
    const tb = `Traceback (most recent call last):\n  File "/data/script.py", line 94, in <module>\n    df["link_count_bucket"] = pd.qcut(df["link_count"], 4)\n                              ^^^^^^^^\nValueError: Bin edges must be unique`;
    const r = classifyFailure("execution", tb);
    expect(r.errorClass).toBe("py_ValueError");
    expect(r.detail).toContain("pd.qcut");
  });

  it("maps the dominant semantic reasons", () => {
    expect(
      classifyFailure("semantic", "Execution produced no results or chart data.").errorClass
    ).toBe("semantic_no_output");
    expect(
      classifyFailure("semantic", 'Chart "x" has only zero values across 3 rows').errorClass
    ).toBe("semantic_all_zeros");
    expect(classifyFailure("semantic", 'Chart "x" has no rows.').errorClass).toBe(
      "semantic_empty_chart"
    );
  });

  it("labels composer key mismatches", () => {
    expect(classifyFailure("compose", "top_30_badge_heavy_low_contrib").errorClass).toBe(
      "compose_key_unresolved"
    );
  });

  it("falls back to py_other for an unrecognized execution error", () => {
    expect(classifyFailure("execution", "weird non-standard failure").errorClass).toBe("py_other");
  });
});

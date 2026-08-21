/**
 * isContextLengthError — the matcher behind "the analysis data is too large
 * for the AI" (L3 backlog #7). It must catch the provider context-overflow
 * wordings and NOTHING else: a bare `includes("too long")` rewrote data-layer
 * errors (Postgres varchar overflow) into misleading AI-size guidance.
 */
import { describe, it, expect } from "vitest";
import { isContextLengthError } from "@/lib/llm/errors";

describe("isContextLengthError", () => {
  it("matches the provider context-overflow wordings", () => {
    expect(isContextLengthError("prompt is too long: 214442 tokens > 200000 maximum")).toBe(true);
    expect(
      isContextLengthError("input length and `max_tokens` exceed context limit: 199999 + 8192")
    ).toBe(true);
    expect(
      isContextLengthError(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 131000 tokens."
      )
    ).toBe(true);
    expect(isContextLengthError("Error code 400: context_length_exceeded")).toBe(true);
    expect(isContextLengthError("context window exceeded")).toBe(true);
  });

  it("does NOT match unrelated errors that merely contain 'too long'", () => {
    // The real-world false positive: a warehouse error surfaced through the
    // pipeline and was rewritten into "data too large for the AI".
    expect(isContextLengthError("value too long for type character varying(40)")).toBe(false);
    expect(isContextLengthError("filename too long")).toBe(false);
    expect(isContextLengthError("the query ran too long and was cancelled")).toBe(false);
    expect(isContextLengthError("request timed out")).toBe(false);
  });
});

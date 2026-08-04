import { describe, it, expect } from "vitest";
// The normalizer lives with the golden runner in scripts/ but is pure and
// unit-tested here so transcript-normalization regressions surface in vitest.
import { normalizeTranscript } from "../../../scripts/golden/normalize.mjs";

describe("golden transcript normalizer", () => {
  it("maps uuids stably across the transcript", () => {
    const a = "11111111-2222-3333-4444-555555555555";
    const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const out = normalizeTranscript([
      JSON.stringify({ csv_id: a }),
      JSON.stringify({ again: a, other: b }),
    ]);
    expect(out).toBe(
      JSON.stringify({ csv_id: "<uuid-1>" }) +
        "\n" +
        JSON.stringify({ again: "<uuid-1>", other: "<uuid-2>" }) +
        "\n"
    );
  });

  it("zeroes volatile numeric fields by key name, wherever nested", () => {
    const out = normalizeTranscript([
      JSON.stringify({ op: "add", value: { duration_ms: 917, elapsed: 3.2, rows: 42 } }),
    ]);
    expect(JSON.parse(out.trim())).toEqual({
      op: "add",
      value: { duration_ms: 0, elapsed: 0, rows: 42 },
    });
  });

  it("drops keepalive and blank frames, keeps non-JSON verbatim", () => {
    const out = normalizeTranscript(["", "{}", "  ", "not-json-frame", '{"ok":true}']);
    expect(out).toBe('not-json-frame\n{"ok":true}\n');
  });

  it("is idempotent — normalizing a normalized transcript is a no-op", () => {
    const lines = [
      JSON.stringify({ csv_id: "12345678-1234-1234-1234-123456789abc", took: 5 }),
      JSON.stringify({ path: "/state/__progress", value: { stage: "exec", elapsed: 1.5 } }),
    ];
    const once = normalizeTranscript(lines);
    const twice = normalizeTranscript(once.trim().split("\n"));
    expect(twice).toBe(once);
  });
});

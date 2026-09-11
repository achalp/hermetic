import { describe, it, expect } from "vitest";
import {
  validateWorkerResult,
  validateWorkerProgress,
  measureDepth,
  DEFAULT_RELAY_LIMITS,
  type RelayLimits,
} from "@/lib/sandbox/wasm/relay";

const LIMITS: RelayLimits = { maxBytes: 1000, maxDepth: 4 };
const okMsg = (over: Record<string, unknown> = {}) => ({
  kind: "result",
  exitCode: 0,
  output: { results: { n: 1 } },
  ...over,
});

describe("measureDepth", () => {
  it("counts the root as depth 1 for a primitive", () => {
    expect(measureDepth(42, 10)).toBe(1);
    expect(measureDepth("s", 10)).toBe(1);
    expect(measureDepth(null, 10)).toBe(1);
  });

  it("measures nested arrays and objects", () => {
    expect(measureDepth([1, 2], 10)).toBe(2); // array(1) → items(2)
    expect(measureDepth({ a: 1 }, 10)).toBe(2);
    expect(measureDepth({ a: { b: [1] } }, 10)).toBe(4); // obj→obj→arr→item
    expect(measureDepth([{ a: 1 }, 2], 10)).toBe(3);
  });

  it("short-circuits to Infinity past the limit — via an array branch", () => {
    expect(measureDepth([[[[[1]]]]], 2)).toBe(Infinity);
  });

  it("short-circuits to Infinity past the limit — via an object branch", () => {
    expect(measureDepth({ a: { b: { c: { d: 1 } } } }, 2)).toBe(Infinity);
  });

  it("takes the max across multiple object keys (both compare branches)", () => {
    expect(measureDepth({ a: 1, b: { c: 1 } }, 10)).toBe(3); // b deeper → update max
    expect(measureDepth({ a: { b: 1 }, c: 1 }, 10)).toBe(3); // c shallower → no update
  });

  it("an empty array/object is just its own depth", () => {
    expect(measureDepth([], 10)).toBe(1);
    expect(measureDepth({}, 10)).toBe(1);
  });
});

describe("validateWorkerResult — the untrusted-worker relay gate", () => {
  it("accepts a well-formed result (no stderr)", () => {
    const v = validateWorkerResult(okMsg(), LIMITS);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.message.exitCode).toBe(0);
      expect(v.message.output).toEqual({ results: { n: 1 } });
      expect("stderr" in v.message).toBe(false);
    }
  });

  it("accepts + carries a string stderr", () => {
    const v = validateWorkerResult(okMsg({ exitCode: 1, stderr: "boom" }), LIMITS);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.message.stderr).toBe("boom");
  });

  it("drops a non-object", () => {
    expect(validateWorkerResult("nope", LIMITS)).toMatchObject({
      ok: false,
      reason: /not an object/,
    });
    expect(validateWorkerResult(null, LIMITS)).toMatchObject({ ok: false });
  });

  it("drops an array (not a plain record)", () => {
    expect(validateWorkerResult([1, 2], LIMITS)).toMatchObject({
      ok: false,
      reason: /not an object/,
    });
  });

  it("drops an unexpected kind (never forwards raw worker chatter)", () => {
    expect(validateWorkerResult({ kind: "exfil", data: "x" }, LIMITS)).toMatchObject({
      ok: false,
      reason: /unexpected kind/,
    });
  });

  it("drops a non-integer exitCode", () => {
    expect(validateWorkerResult(okMsg({ exitCode: "0" }), LIMITS)).toMatchObject({ ok: false });
    expect(validateWorkerResult(okMsg({ exitCode: 1.5 }), LIMITS)).toMatchObject({
      ok: false,
      reason: /integer/,
    });
  });

  it("drops a message missing output", () => {
    const { output: _drop, ...noOutput } = okMsg();
    void _drop;
    expect(validateWorkerResult(noOutput, LIMITS)).toMatchObject({
      ok: false,
      reason: /missing output/,
    });
  });

  it("drops a non-string stderr", () => {
    expect(validateWorkerResult(okMsg({ stderr: 5 }), LIMITS)).toMatchObject({
      ok: false,
      reason: /stderr must be a string/,
    });
  });

  it("drops a non-serializable payload (BigInt)", () => {
    expect(validateWorkerResult(okMsg({ output: { n: BigInt(1) } }), LIMITS)).toMatchObject({
      ok: false,
      reason: /not serializable/,
    });
  });

  it("drops an over-size envelope (sidecar OOM guard)", () => {
    const big = "x".repeat(2000);
    expect(validateWorkerResult(okMsg({ output: { big } }), LIMITS)).toMatchObject({
      ok: false,
      reason: /exceeds .*cap/,
    });
  });

  it("drops an over-depth output (composer DoS guard)", () => {
    expect(
      validateWorkerResult(okMsg({ output: { a: { b: { c: { d: 1 } } } } }), LIMITS)
    ).toMatchObject({
      ok: false,
      reason: /depth/,
    });
  });

  it("uses DEFAULT_RELAY_LIMITS when none supplied", () => {
    expect(validateWorkerResult(okMsg()).ok).toBe(true);
    expect(DEFAULT_RELAY_LIMITS.maxBytes).toBeGreaterThan(0);
  });
});

describe("validateWorkerProgress — the tiny display-only frame gate", () => {
  it("accepts a minimal frame and a full frame", () => {
    expect(validateWorkerProgress({ kind: "progress", phase: "scanning" })).toMatchObject({
      ok: true,
      message: { kind: "progress", phase: "scanning" },
    });
    const v = validateWorkerProgress({
      kind: "progress",
      phase: "scanning",
      detail: "west shard",
      fraction: 0.5,
    });
    expect(v).toMatchObject({ ok: true, message: { detail: "west shard", fraction: 0.5 } });
  });

  it("rejects wrong kind, missing/empty phase, and non-string detail", () => {
    expect(validateWorkerProgress({ kind: "result", phase: "x" }).ok).toBe(false);
    expect(validateWorkerProgress({ kind: "progress", phase: "" }).ok).toBe(false);
    expect(validateWorkerProgress({ kind: "progress" }).ok).toBe(false);
    expect(validateWorkerProgress({ kind: "progress", phase: "x", detail: 1 }).ok).toBe(false);
    expect(validateWorkerProgress("nope").ok).toBe(false);
  });

  it("CLAMPS oversized strings and out-of-range fractions instead of rejecting", () => {
    const v = validateWorkerProgress({
      kind: "progress",
      phase: "p".repeat(1000),
      detail: "d".repeat(5000),
      fraction: 7,
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.message.phase).toHaveLength(120);
      expect(v.message.detail).toHaveLength(500);
      expect(v.message.fraction).toBe(1);
    }
    const neg = validateWorkerProgress({ kind: "progress", phase: "x", fraction: -3 });
    if (neg.ok) expect(neg.message.fraction).toBe(0);
  });

  it("drops a non-finite fraction silently (frame still forwards)", () => {
    const v = validateWorkerProgress({ kind: "progress", phase: "x", fraction: NaN });
    expect(v.ok).toBe(true);
    if (v.ok) expect("fraction" in v.message).toBe(false);
  });
});

import { describe, it, expect, vi } from "vitest";
import { logger, errMessage, serializeError } from "../logger";

describe("errMessage", () => {
  it("returns the message for an Error", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });
  it("stringifies a non-Error", () => {
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(null)).toBe("null");
  });
  it("is behavior-identical to the inline ternary it replaces", () => {
    for (const v of [new Error("x"), "y", 0, undefined, { a: 1 }]) {
      const inline = v instanceof Error ? v.message : String(v);
      expect(errMessage(v)).toBe(inline);
    }
  });
});

describe("serializeError cause chain", () => {
  it("preserves a wrapped error's cause", () => {
    const root = new Error("driver ECONNREFUSED");
    const wrapped = new Error("Cannot read dbt manifest", { cause: root });
    const out = serializeError(wrapped);
    expect(out.error).toBe("Cannot read dbt manifest");
    expect(String(out.cause)).toContain("driver ECONNREFUSED");
  });
});

describe("logger", () => {
  it("has all log level methods", () => {
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("calls console.error for error level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error("test error", { code: 500 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("calls console.warn for warn level", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger.warn("test warning");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

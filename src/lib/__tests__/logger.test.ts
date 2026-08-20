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

describe("meta secret redaction (finding PE-4 — value-embedded secrets)", () => {
  const capture = (fn: () => void): string => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fn();
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    spy.mockRestore();
    return out;
  };

  it("redacts a connection-URL password under a benign key", () => {
    const out = capture(() =>
      logger.error("db fail", { error: "connect postgres://admin:s3cr3tpw@db.internal/app failed" })
    );
    expect(out).not.toContain("s3cr3tpw");
    expect(out).toContain("[redacted]");
  });

  it("redacts secret-bearing query params (presigned URL / token)", () => {
    const out = capture(() =>
      logger.error("fetch fail", { url: "https://h/x?X-Amz-Signature=abcSIGdef&token=TOK123" })
    );
    expect(out).not.toContain("abcSIGdef");
    expect(out).not.toContain("TOK123");
  });

  it("redacts an AWS access-key id and a Bearer token", () => {
    const out = capture(() =>
      logger.error("aws", {
        note: "used AKIAIOSFODNN7EXAMPLE with Authorization: Bearer abcdef123456",
      })
    );
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("abcdef123456");
  });

  it("recurses into nested objects/arrays", () => {
    const out = capture(() =>
      logger.error("cfg", {
        config: { dsn: "mysql://u:hunter2@h/db" },
        list: ["clickhouse://x:pw99@h"],
      })
    );
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("pw99");
  });

  it("still redacts by secret-shaped KEY, and leaves ordinary values intact", () => {
    const out = capture(() =>
      logger.error("ok", { password: "topsecret", rows: 42, name: "quarterly report" })
    );
    expect(out).not.toContain("topsecret");
    expect(out).toContain("42");
    expect(out).toContain("quarterly report"); // no over-redaction
  });
});

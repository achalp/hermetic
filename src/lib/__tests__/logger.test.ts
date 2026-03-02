import { describe, it, expect, vi } from "vitest";
import { logger } from "../logger";

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

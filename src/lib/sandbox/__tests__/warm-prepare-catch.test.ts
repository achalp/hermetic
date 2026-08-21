/**
 * Static-analysis sweep fix: prepareWarmSandbox's fire-and-forget backend
 * registration must never surface an UNHANDLED rejection — a registration
 * failure (failed dynamic import / backend constructor throw) becomes a scoped
 * warning. (Vitest itself fails a test file on unhandled rejections, so this
 * test also guards the absence of one.)
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/sandbox/docker-warm-backend", () => ({
  DockerWarmBackend: class {
    constructor() {
      throw new Error("backend construction exploded");
    }
  },
}));

import { prepareWarmSandbox } from "@/lib/sandbox/warm-sandbox";
import { logger } from "@/lib/logger";

describe("prepareWarmSandbox — registration failure is caught, not unhandled", () => {
  it("logs a scoped warning when the backend cannot be constructed", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    prepareWarmSandbox("csv-x", "a\n1\n", "docker");
    await new Promise((r) => setTimeout(r, 0)); // flush the rejection path
    expect(warn).toHaveBeenCalledWith(
      "Warm sandbox registration failed",
      expect.objectContaining({ error: expect.stringContaining("exploded") })
    );
    warn.mockRestore();
  });
});

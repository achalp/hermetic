import { describe, it, expect, vi, afterEach } from "vitest";
import { runWithRunId, getRunId } from "@/lib/run-context";
import { logger } from "@/lib/logger";

afterEach(() => vi.restoreAllMocks());

describe("run correlation context", () => {
  it("mints a short id inside the scope, none outside", async () => {
    expect(getRunId()).toBeUndefined();
    await runWithRunId(async () => {
      expect(getRunId()).toMatch(/^[0-9a-f]{8}$/);
    });
    expect(getRunId()).toBeUndefined();
  });

  it("gives concurrent runs distinct ids", async () => {
    const ids: string[] = [];
    await Promise.all([
      runWithRunId(async () => {
        ids.push(getRunId()!);
      }),
      runWithRunId(async () => {
        ids.push(getRunId()!);
      }),
    ]);
    expect(new Set(ids).size).toBe(2);
  });

  it("threads the id into every logger line in the scope", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await runWithRunId(async () => {
      const id = getRunId()!;
      logger.info("hello from run");
      expect(spy).toHaveBeenCalledWith(expect.stringContaining(`[${id}]`));
    });
    // Outside the scope: no run chip.
    logger.info("outside");
    const last = spy.mock.calls.at(-1)![0] as string;
    expect(last).not.toMatch(/\[[0-9a-f]{8}\]/);
  });
});

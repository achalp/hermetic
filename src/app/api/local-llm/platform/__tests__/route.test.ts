import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/local-llm/platform — reports OS/arch and which local-LLM tools are
 * installed by probing the shell (execSync mocked). Verifies the tool-presence
 * flags reflect the probe results without touching the real system.
 */
const execSync = vi.fn();
vi.mock("child_process", () => ({ execSync: (...a: unknown[]) => execSync(...a) }));
vi.mock("@/lib/paths", () => ({ hermeticPaths: { bundledBinDir: () => "/bin" } }));

import { GET } from "@/app/api/local-llm/platform/route";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/local-llm/platform", () => {
  it("reports tools present when the probes succeed", async () => {
    execSync.mockReturnValue(""); // every `which`/import succeeds
    const body = await (await GET()).json();
    expect(body.os).toBe(process.platform);
    expect(body.arch).toBe(process.arch);
    expect(body.hasPython).toBe(true);
    expect(body.hasOllama).toBe(true);
    expect(body.hasHfCli).toBe(true);
  });

  it("reports tools absent when the probes throw", async () => {
    execSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const body = await (await GET()).json();
    expect(body.hasPython).toBe(false);
    expect(body.hasOllama).toBe(false);
    expect(body.hasLlamaServer).toBe(false);
  });
});

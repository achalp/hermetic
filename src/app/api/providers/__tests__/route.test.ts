/**
 * Tests for the /api/providers route — specifically that the claude-cli
 * provider surfaces in `configured` when the binary is available and that it's
 * an accepted target for the PUT switch. Client + transport + runtime-config are
 * mocked at their module boundaries so the route logic is what's under test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getActiveProvider, isClaudeCliAvailable, setRuntimeConfig } = vi.hoisted(() => ({
  getActiveProvider: vi.fn(() => "claude-cli"),
  isClaudeCliAvailable: vi.fn(() => true),
  setRuntimeConfig: vi.fn(),
}));

vi.mock("@/lib/llm/client", () => ({ getActiveProvider }));
vi.mock("@/lib/llm/claude-cli-transport", () => ({ isClaudeCliAvailable }));
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => ({}),
  setRuntimeConfig,
}));

import { GET, PUT } from "@/app/api/providers/route";

const CRED_ENVS = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "GOOGLE_VERTEX_PROJECT",
  "OPENAI_BASE_URL",
];

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProvider.mockReturnValue("claude-cli");
  isClaudeCliAvailable.mockReturnValue(true);
  for (const k of CRED_ENVS) vi.stubEnv(k, "");
});

describe("GET /api/providers", () => {
  it("lists claude-cli in configured and labels the active provider", async () => {
    const body = await GET().json();
    expect(body.active).toBe("claude-cli");
    expect(body.activeLabel).toBe("Claude CLI");
    expect(body.configured).toContain("claude-cli");
  });

  it("omits claude-cli from configured when the binary is unavailable", async () => {
    isClaudeCliAvailable.mockReturnValue(false);
    getActiveProvider.mockReturnValue("anthropic");
    const body = await GET().json();
    expect(body.configured).not.toContain("claude-cli");
  });
});

describe("PUT /api/providers", () => {
  it("accepts claude-cli and persists it as the active provider", async () => {
    const req = new Request("http://x/api/providers", {
      method: "PUT",
      body: JSON.stringify({ provider: "claude-cli" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(200);
    expect(setRuntimeConfig).toHaveBeenCalledWith({ activeProvider: "claude-cli" });
  });

  it("rejects an unknown provider", async () => {
    const req = new Request("http://x/api/providers", {
      method: "PUT",
      body: JSON.stringify({ provider: "totally-fake" }),
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    expect(setRuntimeConfig).not.toHaveBeenCalled();
  });
});

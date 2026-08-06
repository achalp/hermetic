/**
 * Provider auto-detection + model-routing tests for lib/llm/client.ts — the
 * file that mediates every LLM call for 7 providers, previously at 4.9%
 * coverage (only two pure helpers were tested). SDK constructors and the
 * runtime config are mocked at their module boundaries; these pin the
 * ROUTING decisions, not the SDKs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const anthropicClient = vi.fn((id: string) => ({ kind: "anthropic-model", id }));
const bedrockClient = vi.fn((id: string) => ({ kind: "bedrock-model", id }));
const vertexClient = vi.fn((id: string) => ({ kind: "vertex-model", id }));
const openaiClient = vi.fn((id: string) => ({ kind: "openai-model", id }));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn(() => anthropicClient) }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock: vi.fn(() => bedrockClient) }));
vi.mock("@ai-sdk/google-vertex", () => ({ createVertex: vi.fn(() => vertexClient) }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn(() => openaiClient) }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    // Pass the model through, capturing the wrap for middleware assertions.
    wrapLanguageModel: vi.fn(({ model, middleware }) => ({ model, middleware })),
  };
});
vi.mock("@/lib/runtime-config", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("@/lib/cost/accumulator", () => ({
  recordCall: vi.fn(),
  currentPhase: vi.fn(() => undefined),
}));
// Default the CLI to "not installed" so credential/detection tests are stable
// on machines that happen to have `claude` on PATH; individual tests opt in.
vi.mock("@/lib/llm/claude-cli-transport", () => ({
  isClaudeCliAvailable: vi.fn(() => false),
  claudeCliFetch: vi.fn(() => vi.fn()),
}));

import { getActiveProvider, getModel, cachedSystem, providerCapabilities } from "@/lib/llm/client";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { isClaudeCliAvailable } from "@/lib/llm/claude-cli-transport";
import { recordCall } from "@/lib/cost/accumulator";
import { createOpenAI } from "@ai-sdk/openai";

const mockedRc = vi.mocked(getRuntimeConfig);
const mockedCliAvailable = vi.mocked(isClaudeCliAvailable);
const mockedRecordCall = vi.mocked(recordCall);

const PROVIDER_ENVS = [
  "LLM_PROVIDER",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "GOOGLE_VERTEX_PROJECT",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  mockedRc.mockReturnValue({} as never);
  for (const k of PROVIDER_ENVS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of PROVIDER_ENVS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getActiveProvider precedence", () => {
  it("throws with setup guidance when nothing is configured", () => {
    expect(() => getActiveProvider()).toThrow(/No LLM provider configured/);
  });

  it("auto-detects from credentials: anthropic > bedrock > vertex > openai-compatible", () => {
    process.env.OPENAI_BASE_URL = "http://x";
    expect(getActiveProvider()).toBe("openai-compatible");
    process.env.GOOGLE_VERTEX_PROJECT = "p";
    expect(getActiveProvider()).toBe("vertex");
    process.env.AWS_PROFILE = "default";
    expect(getActiveProvider()).toBe("bedrock");
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(getActiveProvider()).toBe("anthropic");
  });

  it("an enabled local backend with an active model beats credential detection", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    mockedRc.mockReturnValue({ mlx: { enabled: true, activeModel: "qwen" } } as never);
    expect(getActiveProvider()).toBe("mlx");
  });

  it("an explicit LLM_PROVIDER env beats local backends and credentials", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    process.env.LLM_PROVIDER = "bedrock";
    mockedRc.mockReturnValue({ ollama: { enabled: true, activeModel: "m" } } as never);
    expect(getActiveProvider()).toBe("bedrock");
  });

  it("the UI-selected runtime-config provider beats everything", () => {
    process.env.LLM_PROVIDER = "bedrock";
    mockedRc.mockReturnValue({ activeProvider: "anthropic" } as never);
    expect(getActiveProvider()).toBe("anthropic");
  });

  it("rejects an invalid LLM_PROVIDER value loudly", () => {
    process.env.LLM_PROVIDER = "gpt5";
    expect(() => getActiveProvider()).toThrow(/Invalid LLM_PROVIDER/);
  });

  it("falls back to claude-cli when no creds are set but the CLI is installed", () => {
    mockedCliAvailable.mockReturnValue(true);
    expect(getActiveProvider()).toBe("claude-cli");
  });

  it("prefers API credentials over the claude-cli fallback", () => {
    mockedCliAvailable.mockReturnValue(true);
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    expect(getActiveProvider()).toBe("anthropic");
  });

  it("honors an explicit LLM_PROVIDER=claude-cli", () => {
    process.env.LLM_PROVIDER = "claude-cli";
    expect(getActiveProvider()).toBe("claude-cli");
  });
});

describe("getModel routing", () => {
  it("anthropic: passes the internal id through and prices under it", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    getModel("claude-sonnet-4-6");
    expect(anthropicClient).toHaveBeenCalledWith("claude-sonnet-4-6");
  });

  it("strips sampling params only for adaptive-only models on cloud Anthropic", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const adaptive = getModel("claude-opus-4-8") as unknown as { middleware: unknown };
    const sampled = getModel("claude-sonnet-4-6") as unknown as { middleware: unknown };
    // Adaptive-only → [stripSampling, usage, replay]; sampled → [usage, replay]
    // (replay is the always-attached passthrough recorder, lib/llm/replay.ts).
    expect(Array.isArray(adaptive.middleware)).toBe(true);
    expect((adaptive.middleware as unknown[]).length).toBe(3);
    expect(Array.isArray(sampled.middleware)).toBe(true);
    expect((sampled.middleware as unknown[]).length).toBe(2);
  });

  it("openai-compatible: requires OPENAI_MODEL and uses it for every call", () => {
    process.env.OPENAI_BASE_URL = "http://proxy";
    expect(() => getModel("claude-sonnet-4-6")).toThrow(/model is required/);
    process.env.OPENAI_MODEL = "corp-llm";
    getModel("claude-sonnet-4-6");
    expect(openaiClient).toHaveBeenCalledWith("corp-llm");
  });

  it("ollama: uses the runtime-config active model over an OpenAI-shaped client", () => {
    mockedRc.mockReturnValue({
      activeProvider: "ollama",
      ollama: { enabled: true, activeModel: "qwen3.5:9b", baseUrl: "http://localhost:11434" },
    } as never);
    getModel("claude-sonnet-4-6"); // internal id is ignored for local backends
    expect(openaiClient).toHaveBeenCalledWith("qwen3.5:9b");
    const cfg = vi.mocked(createOpenAI).mock.calls.at(-1)![0] as { baseURL?: string };
    expect(cfg.baseURL).toBe("http://localhost:11434/v1");
  });

  it("local backend without an active model throws an actionable error", () => {
    mockedRc.mockReturnValue({ activeProvider: "mlx", mlx: { enabled: true } } as never);
    expect(() => getModel("claude-sonnet-4-6")).toThrow(/No MLX model selected/);
  });

  it("claude-cli: maps the internal id to the real Claude model and does not strip sampling", () => {
    process.env.LLM_PROVIDER = "claude-cli";
    // Adaptive-only model would strip sampling on cloud Anthropic; via the CLI
    // our fetch ignores sampling, so no stripSampling — just [usage, replay].
    const wrapped = getModel("claude-opus-4-8") as unknown as { middleware: unknown };
    expect(openaiClient).toHaveBeenCalledWith("claude-opus-4-8");
    expect(Array.isArray(wrapped.middleware)).toBe(true);
    expect((wrapped.middleware as unknown[]).length).toBe(2);
    // The client was built pointing at the claude-cli dummy base URL.
    const cfg = vi.mocked(createOpenAI).mock.calls.at(-1)![0] as { baseURL?: string };
    expect(cfg.baseURL).toBe("http://claude-cli.local/v1");
  });

  it("claude-cli prices usage at the equivalent API rate (internal model id cost key)", async () => {
    process.env.LLM_PROVIDER = "claude-cli";
    const wrapped = getModel("claude-opus-4-8") as unknown as {
      middleware: Array<{
        wrapGenerate: (o: { doGenerate: () => Promise<{ usage: unknown }> }) => Promise<unknown>;
      }>;
    };
    // Usage middleware is outermost (index 0); replay passthrough sits inner.
    await wrapped.middleware[0].wrapGenerate({
      doGenerate: async () => ({
        usage: { inputTokens: { total: 100 }, outputTokens: { total: 20 } },
      }),
    });
    // Keyed on "claude-opus-4-8" (a MODEL_PRICING entry) → equivalent API cost,
    // NOT a $0 "claude-cli:"-prefixed key.
    expect(mockedRecordCall).toHaveBeenCalledWith(
      "claude-opus-4-8",
      expect.objectContaining({ uncachedInputTokens: 100, outputTokens: 20 }),
      undefined
    );
  });
});

describe("providerCapabilities", () => {
  it("treats claude-cli as a real Claude provider (validate ids, Investigate on)", () => {
    expect(providerCapabilities("claude-cli")).toEqual({
      skipModelValidation: false,
      supportsInvestigate: true,
    });
  });

  it("keeps local backends restricted", () => {
    expect(providerCapabilities("ollama")).toEqual({
      skipModelValidation: true,
      supportsInvestigate: false,
    });
  });
});

describe("cachedSystem", () => {
  it("wraps with an Anthropic 1h cache breakpoint only on the anthropic provider", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant";
    const wrapped = cachedSystem("big prompt");
    expect(wrapped).toMatchObject({
      role: "system",
      content: "big prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    });

    delete process.env.ANTHROPIC_API_KEY;
    process.env.LLM_PROVIDER = "bedrock";
    expect(cachedSystem("big prompt")).toBe("big prompt"); // plain string elsewhere
  });
});

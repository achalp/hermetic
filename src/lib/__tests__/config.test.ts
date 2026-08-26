import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock runtime-config so tests don't read from disk (data/runtime-config.json)
vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: () => ({}),
  clearRuntimeConfigCache: () => {},
}));

// Control CLI availability via a hoisted holder so the factory survives
// vi.resetModules(). Default false so credential-detection tests are stable on
// machines that have `claude` installed.
const mockCli = vi.hoisted(() => ({ available: false }));
vi.mock("@/lib/llm/claude-cli-transport", () => ({
  isClaudeCliAvailable: () => mockCli.available,
}));

// Must reset module between tests since config caches
beforeEach(() => {
  vi.resetModules();
  mockCli.available = false;
});

describe("validateEnv", () => {
  it("throws when no LLM provider credentials are set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LLM_PROVIDER", "");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("No LLM provider configured");

    vi.unstubAllEnvs();
  });

  it("forces docker: a stale SANDBOX_RUNTIME=e2b is ignored, not degraded", async () => {
    // The README documents E2B/microsandbox as experimental + not selectable —
    // Docker is enforced for the --network none isolation guarantee. A leftover
    // SANDBOX_RUNTIME=e2b from an old .env must resolve to docker, never silently
    // run on a runtime that can't isolate the network.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");
    vi.stubEnv("SANDBOX_RUNTIME", "e2b");
    vi.stubEnv("LLM_PROVIDER", "");
    const { validateEnv } = await import("../config");
    expect(validateEnv().SANDBOX_RUNTIME).toBe("docker");
    vi.unstubAllEnvs();
  });

  it("succeeds with valid ANTHROPIC_API_KEY (auto-detect)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test-key");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("LLM_PROVIDER", "");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("anthropic");
    expect(config.SANDBOX_RUNTIME).toBe("docker");

    vi.unstubAllEnvs();
  });

  it("detects Bedrock from AWS_ACCESS_KEY_ID", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("bedrock");

    vi.unstubAllEnvs();
  });

  it("detects Bedrock from AWS_PROFILE", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "my-profile");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("bedrock");

    vi.unstubAllEnvs();
  });

  it("detects Vertex from GOOGLE_VERTEX_PROJECT", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "my-gcp-project");
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("vertex");

    vi.unstubAllEnvs();
  });

  it("respects explicit LLM_PROVIDER=bedrock", async () => {
    vi.stubEnv("LLM_PROVIDER", "bedrock");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAIOSFODNN7EXAMPLE");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("bedrock");

    vi.unstubAllEnvs();
  });

  it("throws for invalid LLM_PROVIDER", async () => {
    vi.stubEnv("LLM_PROVIDER", "cohere");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("Invalid LLM_PROVIDER");

    vi.unstubAllEnvs();
  });

  it("throws when Anthropic provider lacks API key", async () => {
    vi.stubEnv("LLM_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("Anthropic API key is required");

    vi.unstubAllEnvs();
  });

  it("throws when Bedrock provider lacks AWS credentials", async () => {
    vi.stubEnv("LLM_PROVIDER", "bedrock");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("AWS credentials are required");

    vi.unstubAllEnvs();
  });

  it("throws when Vertex provider lacks project", async () => {
    vi.stubEnv("LLM_PROVIDER", "vertex");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("Vertex project is required");

    vi.unstubAllEnvs();
  });

  it("detects openai-compatible from OPENAI_BASE_URL", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_MODEL", "llama3.3");
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("openai-compatible");
    expect(config.OPENAI_BASE_URL).toBe("http://localhost:11434/v1");
    expect(config.OPENAI_MODEL).toBe("llama3.3");

    vi.unstubAllEnvs();
  });

  it("respects explicit LLM_PROVIDER=openai-compatible", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_MODEL", "llama3.3");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    const config = validateEnv();

    expect(config.LLM_PROVIDER).toBe("openai-compatible");

    vi.unstubAllEnvs();
  });

  it("throws when openai-compatible provider lacks OPENAI_BASE_URL", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("OPENAI_MODEL", "llama3.3");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("base URL is required");

    vi.unstubAllEnvs();
  });

  it("throws when openai-compatible provider lacks OPENAI_MODEL", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("OPENAI_BASE_URL", "http://localhost:11434/v1");
    vi.stubEnv("OPENAI_MODEL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow("model is required");

    vi.unstubAllEnvs();
  });

  it("auto-detects claude-cli when installed and no API creds are set", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("LLM_PROVIDER", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");
    mockCli.available = true;

    const { validateEnv } = await import("../config");
    expect(validateEnv().LLM_PROVIDER).toBe("claude-cli");

    vi.unstubAllEnvs();
  });

  it("respects explicit LLM_PROVIDER=claude-cli when the binary is present", async () => {
    vi.stubEnv("LLM_PROVIDER", "claude-cli");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");
    mockCli.available = true;

    const { validateEnv } = await import("../config");
    expect(validateEnv().LLM_PROVIDER).toBe("claude-cli");

    vi.unstubAllEnvs();
  });

  it("throws when claude-cli is selected but the binary is missing", async () => {
    vi.stubEnv("LLM_PROVIDER", "claude-cli");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "");
    vi.stubEnv("SANDBOX_RUNTIME", "docker");
    mockCli.available = false;

    const { validateEnv } = await import("../config");
    expect(() => validateEnv()).toThrow(/'claude' binary was not found/);

    vi.unstubAllEnvs();
  });

  // SANDBOX_RUNTIME validation (invalid value / e2b key / microsandbox URL) was
  // removed with the E2B/microsandbox runtimes — Docker is the only runtime and a
  // stale env value is ignored rather than a hard error.
});

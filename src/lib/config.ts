/**
 * Runtime environment validation.
 * Call `validateEnv()` at server startup to fail fast on missing config.
 */

import type { LLMProviderId } from "@/lib/constants";
import { detectActiveProvider, VALID_PROVIDERS } from "@/lib/llm/client";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { isClaudeCliAvailable } from "@/lib/llm/claude-cli-transport";
import { envConfig } from "@/lib/harness-slot";

export interface EnvConfig {
  LLM_PROVIDER: LLMProviderId;
  SANDBOX_RUNTIME: "docker" | "e2b" | "microsandbox";
  E2B_API_KEY?: string;
  MICROSANDBOX_URL?: string;
  MICROSANDBOX_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
}

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

let cachedConfig: EnvConfig | null = null;

/** Clear the cached env config so validateEnv() re-evaluates on next call. */
export function clearEnvConfigCache(): void {
  cachedConfig = null;
}

// Provider detection lives in ONE place: client.ts detectActiveProvider
// (modularization M2-B2). The previous local copy had drifted — it ignored
// the Settings-UI provider selection (rc.activeProvider), so validateEnv
// could disagree with the provider actually in use.
const detectProvider = detectActiveProvider;

export function validateEnv(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  // --- LLM provider validation ---
  const explicitProvider = envConfig().LLM_PROVIDER;
  if (
    explicitProvider &&
    !(VALID_PROVIDERS as readonly string[]).includes(explicitProvider.toLowerCase())
  ) {
    throw new EnvError(
      `Invalid LLM_PROVIDER "${explicitProvider}". Must be one of: ${VALID_PROVIDERS.join(", ")}`
    );
  }

  const provider = detectProvider();
  if (!provider) {
    throw new EnvError(
      "No LLM provider configured. Set one of:\n" +
        "  - ANTHROPIC_API_KEY (for Anthropic direct)\n" +
        "  - AWS_ACCESS_KEY_ID (for Amazon Bedrock)\n" +
        "  - GOOGLE_VERTEX_PROJECT (for Google Vertex AI)\n" +
        "  - OPENAI_BASE_URL (for OpenAI-compatible endpoint)\n" +
        "Or set LLM_PROVIDER explicitly, or enable Ollama in Settings."
    );
  }

  // Validate provider-specific credentials
  if (provider === "anthropic" && !envConfig().ANTHROPIC_API_KEY) {
    throw new EnvError(
      "ANTHROPIC_API_KEY is required when using the Anthropic provider. " +
        "Get one at https://console.anthropic.com/settings/keys"
    );
  }

  if (
    provider === "claude-cli" &&
    !isClaudeCliAvailable(getRuntimeConfig().claudeCli?.binaryPath)
  ) {
    throw new EnvError(
      "Claude CLI provider selected but the 'claude' binary was not found. " +
        "Install it (npm install -g @anthropic-ai/claude-code) and run 'claude' once to authenticate, " +
        "or set claudeCli.binaryPath in Settings."
    );
  }

  if (provider === "bedrock") {
    if (!envConfig().AWS_ACCESS_KEY_ID && !envConfig().AWS_PROFILE) {
      throw new EnvError(
        "AWS credentials are required when using the Bedrock provider. " +
          "Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_PROFILE."
      );
    }
  }

  if (provider === "vertex") {
    if (!envConfig().GOOGLE_VERTEX_PROJECT) {
      throw new EnvError("GOOGLE_VERTEX_PROJECT is required when using the Vertex AI provider.");
    }
  }

  if (provider === "openai-compatible") {
    if (!envConfig().OPENAI_BASE_URL) {
      throw new EnvError(
        "OPENAI_BASE_URL is required when using the openai-compatible provider. " +
          "Example: http://localhost:11434/v1 (Ollama)"
      );
    }
    if (!envConfig().OPENAI_MODEL) {
      throw new EnvError(
        "OPENAI_MODEL is required when using the openai-compatible provider. " +
          "Example: llama3.3, gpt-4o, mistral"
      );
    }
  }

  // --- Sandbox runtime validation ---
  const runtime = (envConfig().SANDBOX_RUNTIME || "docker") as EnvConfig["SANDBOX_RUNTIME"];
  if (!["docker", "e2b", "microsandbox"].includes(runtime)) {
    throw new EnvError(
      `Invalid SANDBOX_RUNTIME "${runtime}". Must be one of: docker, e2b, microsandbox`
    );
  }

  if (runtime === "e2b" && !envConfig().E2B_API_KEY) {
    throw new EnvError("E2B_API_KEY is required when SANDBOX_RUNTIME=e2b");
  }

  if (runtime === "microsandbox") {
    if (!envConfig().MICROSANDBOX_URL) {
      throw new EnvError("MICROSANDBOX_URL is required when SANDBOX_RUNTIME=microsandbox");
    }
  }

  cachedConfig = {
    LLM_PROVIDER: provider,
    SANDBOX_RUNTIME: runtime,
    E2B_API_KEY: envConfig().E2B_API_KEY,
    MICROSANDBOX_URL: envConfig().MICROSANDBOX_URL,
    MICROSANDBOX_API_KEY: envConfig().MICROSANDBOX_API_KEY,
    OPENAI_BASE_URL: envConfig().OPENAI_BASE_URL,
    OPENAI_MODEL: envConfig().OPENAI_MODEL,
  };

  return cachedConfig;
}

// Env validation runs as an explicit harness boot step
// (instrumentation-node installBootConfig) — no import side effects here.

/**
 * Runtime environment validation.
 * Call `validateEnv()` at server startup to fail fast on missing config.
 */

import type { LLMProviderId } from "@/lib/constants";
import { detectActiveProvider, VALID_PROVIDERS } from "@/lib/llm/client";
import { getRuntimeConfig } from "@/lib/runtime-config";
import { isClaudeCliAvailable } from "@/lib/llm/claude-cli-transport";
import { envConfig } from "@/lib/harness-slot";
import { openaiBaseUrl, openaiModel, vertexProject } from "@/lib/settings";
import { getApiKey } from "@/lib/secrets";

export interface EnvConfig {
  LLM_PROVIDER: LLMProviderId;
  SANDBOX_RUNTIME: "docker";
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
  if (provider === "anthropic" && !getApiKey("anthropic")) {
    throw new EnvError(
      "An Anthropic API key is required for the Anthropic provider — add it in Settings " +
        "(stored in your OS keychain) or set ANTHROPIC_API_KEY. " +
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
    if (!vertexProject()) {
      throw new EnvError(
        "A Vertex project is required — set it in Settings or via GOOGLE_VERTEX_PROJECT."
      );
    }
  }

  if (provider === "openai-compatible") {
    if (!openaiBaseUrl()) {
      throw new EnvError(
        "A base URL is required for the openai-compatible provider — set it in Settings " +
          "or via OPENAI_BASE_URL. Example: http://localhost:11434/v1 (Ollama)"
      );
    }
    if (!openaiModel()) {
      throw new EnvError(
        "A model is required for the openai-compatible provider — set it in Settings " +
          "or via OPENAI_MODEL. Example: llama3.3, gpt-4o, mistral"
      );
    }
  }

  // --- Sandbox runtime validation ---
  // Docker is the only runtime; a stale SANDBOX_RUNTIME=e2b/microsandbox is
  // ignored (those were removed) rather than a hard error, so existing envs boot.
  const runtime = "docker" as const;

  cachedConfig = {
    LLM_PROVIDER: provider,
    SANDBOX_RUNTIME: runtime,
    OPENAI_BASE_URL: openaiBaseUrl(),
    OPENAI_MODEL: openaiModel(),
  };

  return cachedConfig;
}

// Env validation runs as an explicit harness boot step
// (instrumentation-node installBootConfig) — no import side effects here.

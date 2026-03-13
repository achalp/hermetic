/**
 * Runtime environment validation.
 * Call `validateEnv()` at server startup to fail fast on missing config.
 */

import type { LLMProviderId } from "@/lib/constants";
import { getRuntimeConfig } from "@/lib/runtime-config";

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

/**
 * Detect which LLM provider is configured (same logic as client.ts getActiveProvider
 * but returns undefined instead of throwing when nothing is found).
 */
function detectProvider(): LLMProviderId | undefined {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (
      [
        "anthropic",
        "bedrock",
        "vertex",
        "openai-compatible",
        "mlx",
        "llama-cpp",
        "ollama",
      ].includes(normalized)
    ) {
      return normalized as LLMProviderId;
    }
    return undefined; // invalid — will be caught below
  }
  // Check runtime config for local backends — user explicitly enabled in UI,
  // so they take priority over auto-detected env var credentials
  const rc = getRuntimeConfig();
  if (rc.mlx?.enabled && rc.mlx.activeModel) return "mlx";
  if (rc.llamaCpp?.enabled && rc.llamaCpp.activeModel) return "llama-cpp";
  if (rc.ollama?.enabled && rc.ollama.activeModel) return "ollama";

  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return "bedrock";
  if (process.env.GOOGLE_VERTEX_PROJECT) return "vertex";
  if (process.env.OPENAI_BASE_URL) return "openai-compatible";

  return undefined;
}

export function validateEnv(): EnvConfig {
  if (cachedConfig) return cachedConfig;

  // --- LLM provider validation ---
  const explicitProvider = process.env.LLM_PROVIDER;
  if (
    explicitProvider &&
    !["anthropic", "bedrock", "vertex", "openai-compatible", "mlx", "llama-cpp", "ollama"].includes(
      explicitProvider.toLowerCase()
    )
  ) {
    throw new EnvError(
      `Invalid LLM_PROVIDER "${explicitProvider}". Must be one of: anthropic, bedrock, vertex, openai-compatible, mlx, llama-cpp, ollama`
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
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new EnvError(
      "ANTHROPIC_API_KEY is required when using the Anthropic provider. " +
        "Get one at https://console.anthropic.com/settings/keys"
    );
  }

  if (provider === "bedrock") {
    if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
      throw new EnvError(
        "AWS credentials are required when using the Bedrock provider. " +
          "Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or AWS_PROFILE."
      );
    }
  }

  if (provider === "vertex") {
    if (!process.env.GOOGLE_VERTEX_PROJECT) {
      throw new EnvError("GOOGLE_VERTEX_PROJECT is required when using the Vertex AI provider.");
    }
  }

  if (provider === "openai-compatible") {
    if (!process.env.OPENAI_BASE_URL) {
      throw new EnvError(
        "OPENAI_BASE_URL is required when using the openai-compatible provider. " +
          "Example: http://localhost:11434/v1 (Ollama)"
      );
    }
    if (!process.env.OPENAI_MODEL) {
      throw new EnvError(
        "OPENAI_MODEL is required when using the openai-compatible provider. " +
          "Example: llama3.3, gpt-4o, mistral"
      );
    }
  }

  // --- Sandbox runtime validation ---
  const runtime = (process.env.SANDBOX_RUNTIME || "docker") as EnvConfig["SANDBOX_RUNTIME"];
  if (!["docker", "e2b", "microsandbox"].includes(runtime)) {
    throw new EnvError(
      `Invalid SANDBOX_RUNTIME "${runtime}". Must be one of: docker, e2b, microsandbox`
    );
  }

  if (runtime === "e2b" && !process.env.E2B_API_KEY) {
    throw new EnvError("E2B_API_KEY is required when SANDBOX_RUNTIME=e2b");
  }

  if (runtime === "microsandbox") {
    if (!process.env.MICROSANDBOX_URL) {
      throw new EnvError("MICROSANDBOX_URL is required when SANDBOX_RUNTIME=microsandbox");
    }
  }

  cachedConfig = {
    LLM_PROVIDER: provider,
    SANDBOX_RUNTIME: runtime,
    E2B_API_KEY: process.env.E2B_API_KEY,
    MICROSANDBOX_URL: process.env.MICROSANDBOX_URL,
    MICROSANDBOX_API_KEY: process.env.MICROSANDBOX_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
  };

  return cachedConfig;
}

/** Validate env on first import (server-side only) */
if (typeof window === "undefined") {
  try {
    validateEnv();
  } catch (e) {
    if (e instanceof EnvError) {
      console.error(`[config] ${e.message}`);
    }
  }
}

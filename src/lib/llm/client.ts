import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import type { LLMProviderId } from "@/lib/constants";

/**
 * Model ID mapping per provider.
 * Internal IDs (used throughout the app) → provider-specific IDs.
 */
const MODEL_MAP: Record<LLMProviderId, Record<string, string>> = {
  anthropic: {
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  },
  bedrock: {
    "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
    "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  vertex: {
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5@20251001",
  },
  "openai-compatible": {},
};

/**
 * Detect which LLM provider to use based on environment variables.
 *
 * Priority:
 * 1. Explicit LLM_PROVIDER env var
 * 2. Auto-detect from available credentials
 * 3. Error if nothing configured
 */
export function getActiveProvider(): LLMProviderId {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit) {
    const normalized = explicit.toLowerCase() as LLMProviderId;
    if (!["anthropic", "bedrock", "vertex", "openai-compatible"].includes(normalized)) {
      throw new Error(
        `Invalid LLM_PROVIDER "${explicit}". Must be one of: anthropic, bedrock, vertex, openai-compatible`
      );
    }
    return normalized;
  }

  // Auto-detect from credentials
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) return "bedrock";
  if (process.env.GOOGLE_VERTEX_PROJECT) return "vertex";
  if (process.env.OPENAI_BASE_URL) return "openai-compatible";

  throw new Error(
    "No LLM provider configured. Set one of:\n" +
      "  - ANTHROPIC_API_KEY (for Anthropic direct)\n" +
      "  - AWS_ACCESS_KEY_ID (for Amazon Bedrock)\n" +
      "  - GOOGLE_VERTEX_PROJECT (for Google Vertex AI)\n" +
      "  - OPENAI_BASE_URL (for OpenAI-compatible endpoint)\n" +
      "Or set LLM_PROVIDER explicitly."
  );
}

function createProviderClient(provider: LLMProviderId) {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    case "bedrock":
      return createAmazonBedrock({
        region: process.env.AWS_REGION ?? "us-east-1",
      });
    case "vertex":
      return createVertex({
        project: process.env.GOOGLE_VERTEX_PROJECT,
        location: process.env.GOOGLE_VERTEX_LOCATION ?? "us-east5",
      });
    case "openai-compatible":
      return createOpenAI({
        baseURL: process.env.OPENAI_BASE_URL,
        apiKey: process.env.OPENAI_API_KEY ?? "",
      });
  }
}

/**
 * Get a LanguageModelV3 instance for the given internal model ID.
 * Routes to the correct provider based on env config.
 */
export function getModel(internalModelId: string) {
  const provider = getActiveProvider();
  const client = createProviderClient(provider);

  // OpenAI-compatible uses a single user-configured model for all calls
  if (provider === "openai-compatible") {
    const model = process.env.OPENAI_MODEL;
    if (!model) {
      throw new Error("OPENAI_MODEL is required when using the openai-compatible provider.");
    }
    return client(model);
  }

  const mappedId = MODEL_MAP[provider][internalModelId] ?? internalModelId;
  return client(mappedId);
}

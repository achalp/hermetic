import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel } from "ai";
import type { SystemModelMessage, TextPart, LanguageModelMiddleware } from "ai";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { DEFAULT_LOCAL_LLM_ENDPOINTS, AVAILABLE_PROVIDERS } from "@/lib/constants";
import type { LLMProviderId } from "@/lib/constants";
import { getRuntimeConfig } from "@/lib/runtime-config";
import {
  openaiBaseUrl,
  openaiModel,
  vertexProject,
  vertexLocation,
  awsRegion,
} from "@/lib/settings";
import { getApiKey } from "@/lib/secrets";
import { recordCall, currentPhase } from "@/lib/cost/accumulator";
import { llmReplayMiddleware } from "@/lib/llm/replay";
import { claudeCliFetch, isClaudeCliAvailable } from "@/lib/llm/claude-cli-transport";
import { ollamaFetch, localOpenAIFetch } from "@/lib/llm/local-openai-fetch";
import { logger } from "@/lib/logger";
import { envConfig } from "@/lib/harness-slot";

/**
 * Model ID mapping per provider.
 * Internal IDs (used throughout the app) → provider-specific IDs.
 */
const MODEL_MAP: Record<LLMProviderId, Record<string, string>> = {
  anthropic: {
    "claude-fable-5": "claude-fable-5",
    "claude-opus-5": "claude-opus-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-opus-4-8": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  },
  // The `claude` CLI accepts the same full model IDs (passed via --model), so
  // it honors the app's per-task model choices (haiku for planning, sonnet for
  // code-gen, …) exactly like the direct Anthropic provider.
  "claude-cli": {
    "claude-fable-5": "claude-fable-5",
    "claude-opus-5": "claude-opus-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-opus-4-8": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  },
  // NOTE: Bedrock cross-region inference-profile IDs follow the `us.anthropic.…`
  // convention; confirm the exact 4.8 profile string against the AWS Bedrock
  // model catalog for your region before deploying there.
  bedrock: {
    "claude-fable-5": "us.anthropic.claude-fable-5-v1",
    "claude-opus-5": "us.anthropic.claude-opus-5-v1",
    "claude-sonnet-5": "us.anthropic.claude-sonnet-5-v1",
    "claude-opus-4-8": "us.anthropic.claude-opus-4-8-v1",
    "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1",
    "claude-sonnet-4-6": "us.anthropic.claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  vertex: {
    "claude-fable-5": "claude-fable-5",
    "claude-opus-5": "claude-opus-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-opus-4-8": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5@20251001",
  },
  "openai-compatible": {},
  mlx: {},
  "llama-cpp": {},
  ollama: {},
};

/**
 * Detect which LLM provider to use based on environment variables.
 *
 * Priority:
 * 1. Explicit LLM_PROVIDER env var
 * 2. Auto-detect from available credentials
 * 3. Error if nothing configured
 */
// DERIVED from AVAILABLE_PROVIDERS (the Settings-UI list) so the two can never
// drift (finding L1): a hand-copied list meant adding a provider to Settings
// while detectActiveProvider silently rejected it. Single source of truth.
export const VALID_PROVIDERS = AVAILABLE_PROVIDERS.map((p) => p.id);

/**
 * THE provider-detection path (modularization M2-B2) — the only
 * implementation; config.ts validateEnv/detectProvider delegate here.
 * Returns undefined instead of throwing so probes can ask "is anything
 * configured?"; getActiveProvider() wraps it with the user-facing errors.
 *
 * Order: Settings-UI selection → explicit LLM_PROVIDER → UI-enabled local
 * backends → credential auto-detect → authenticated `claude` CLI fallback.
 */
export function detectActiveProvider(): LLMProviderId | undefined {
  const rc = getRuntimeConfig();
  if (rc.activeProvider && (VALID_PROVIDERS as readonly string[]).includes(rc.activeProvider)) {
    return rc.activeProvider as LLMProviderId;
  }

  const explicit = envConfig().LLM_PROVIDER;
  if (explicit) {
    const normalized = explicit.toLowerCase() as LLMProviderId;
    // Invalid explicit selection is terminal (no silent fallback) — the
    // caller surfaces the error.
    return (VALID_PROVIDERS as readonly string[]).includes(normalized) ? normalized : undefined;
  }

  if (rc.mlx?.enabled && rc.mlx.activeModel) return "mlx";
  if (rc.llamaCpp?.enabled && rc.llamaCpp.activeModel) return "llama-cpp";
  if (rc.ollama?.enabled && rc.ollama.activeModel) return "ollama";

  if (getApiKey("anthropic")) return "anthropic";
  if (envConfig().AWS_ACCESS_KEY_ID || envConfig().AWS_PROFILE) return "bedrock";
  if (vertexProject()) return "vertex";
  if (openaiBaseUrl()) return "openai-compatible";

  // Last resort: no API credentials, but the `claude` CLI is installed and
  // authenticated. Checked last so a configured key always wins.
  if (isClaudeCliAvailable(rc.claudeCli?.binaryPath)) return "claude-cli";

  return undefined;
}

export function getActiveProvider(): LLMProviderId {
  const detected = detectActiveProvider();
  if (detected) return detected;

  const explicit = envConfig().LLM_PROVIDER;
  if (explicit && !(VALID_PROVIDERS as readonly string[]).includes(explicit.toLowerCase())) {
    throw new Error(
      `Invalid LLM_PROVIDER "${explicit}". Must be one of: ${VALID_PROVIDERS.join(", ")}`
    );
  }

  throw new Error(
    "No LLM provider configured. Set one of:\n" +
      "  - ANTHROPIC_API_KEY (for Anthropic direct)\n" +
      "  - AWS_ACCESS_KEY_ID (for Amazon Bedrock)\n" +
      "  - GOOGLE_VERTEX_PROJECT (for Google Vertex AI)\n" +
      "  - OPENAI_BASE_URL (for OpenAI-compatible endpoint)\n" +
      "Or install the Claude CLI (npm i -g @anthropic-ai/claude-code), " +
      "set LLM_PROVIDER explicitly, or enable a local backend in Settings."
  );
}

function createProviderClient(provider: LLMProviderId) {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: getApiKey("anthropic") });
    case "claude-cli": {
      const rc = getRuntimeConfig();
      // Dummy base URL — every request is intercepted by claudeCliFetch, which
      // spawns the `claude` binary instead of making an HTTP call. The apiKey is
      // never sent (the CLI uses its own auth) but the SDK requires a non-empty one.
      return createOpenAI({
        baseURL: "http://claude-cli.local/v1",
        apiKey: "claude-cli",
        fetch: claudeCliFetch({ binaryPath: rc.claudeCli?.binaryPath }),
      });
    }
    case "bedrock":
      return createAmazonBedrock({
        region: awsRegion() ?? "us-east-1",
      });
    case "vertex":
      return createVertex({
        project: vertexProject(),
        location: vertexLocation() ?? "us-east5",
      });
    case "openai-compatible":
      return createOpenAI({
        baseURL: openaiBaseUrl(),
        apiKey: getApiKey("openai") ?? "",
      });
    case "mlx": {
      const rc = getRuntimeConfig();
      const baseUrl = rc.mlx?.baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS.mlx;
      return createOpenAI({
        baseURL: `${baseUrl}/v1`,
        apiKey: "mlx-local",
        fetch: localOpenAIFetch(baseUrl),
      });
    }
    case "llama-cpp": {
      const rc = getRuntimeConfig();
      const baseUrl = rc.llamaCpp?.baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS["llama-cpp"];
      return createOpenAI({
        baseURL: `${baseUrl}/v1`,
        apiKey: "llama-cpp-local",
        fetch: localOpenAIFetch(baseUrl),
      });
    }
    case "ollama": {
      const rc = getRuntimeConfig();
      const baseUrl = rc.ollama?.baseUrl || DEFAULT_LOCAL_LLM_ENDPOINTS.ollama;
      return createOpenAI({
        baseURL: `${baseUrl}/v1`,
        apiKey: "ollama",
        // Ollama's OpenAI-compatible endpoint (/v1) ignores num_ctx.
        // Intercept requests and redirect to the native /api/chat
        // endpoint which supports options.num_ctx, then translate
        // the NDJSON response back to OpenAI SSE format.
        fetch: ollamaFetch(baseUrl),
      });
    }
  }
}

/**
 * Get a LanguageModelV3 instance for the given internal model ID.
 * Routes to the correct provider based on env config.
 */
/**
 * Middleware that reports each call's token usage to the cost accumulator (a
 * no-op outside a tracked analysis scope). `costKey` is the pricing key: the
 * internal model id for cloud Anthropic providers (matches MODEL_PRICING),
 * otherwise the local model name (priced at $0, tokens still tracked).
 */
/** The V3 provider-level usage shape (structured input/output token buckets). */
interface V3Usage {
  inputTokens?: { noCache?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  outputTokens?: { total?: number };
}

function reportUsage(
  costKey: string,
  usage: V3Usage | undefined,
  phase?: string,
  durationMs?: number
): void {
  const inp = usage?.inputTokens;
  recordCall(
    costKey,
    {
      uncachedInputTokens: inp?.noCache ?? inp?.total ?? 0,
      cacheReadTokens: inp?.cacheRead ?? 0,
      cacheWriteTokens: inp?.cacheWrite ?? 0,
      outputTokens: usage?.outputTokens?.total ?? 0,
      durationMs,
    },
    phase
  );
}

function usageMiddleware(costKey: string): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      // Capture the phase NOW (within the caller's withPhase scope), not after
      // the await — belt-and-suspenders so attribution can't drift.
      const phase = currentPhase();
      const start = Date.now();
      const result = await doGenerate();
      reportUsage(costKey, result.usage as V3Usage, phase, Date.now() - start);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      // streamText reports usage on the "finish" chunk during consumption —
      // outside the withPhase scope — so we MUST bind the phase here, at stream
      // initiation, which still runs inside the scope (streamText is eager).
      const phase = currentPhase();
      const start = Date.now();
      const { stream, ...rest } = await doStream();
      return {
        stream: stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk.type === "finish") {
                // Duration = request start → finish chunk (full stream time).
                reportUsage(
                  costKey,
                  (chunk as { usage?: V3Usage }).usage,
                  phase,
                  Date.now() - start
                );
              }
              controller.enqueue(chunk);
            },
          })
        ),
        ...rest,
      };
    },
  };
}

/**
 * Opus 4.7+ (claude-opus-4-7, -4-8, …) and the Fable/Mythos family removed the
 * sampling parameters — temperature/top_p/top_k (and budget_tokens) return a 400;
 * only adaptive thinking is supported. Our call sites set `temperature` for the
 * 4.6-family models (Sonnet 4.6, Haiku 4.5) that still accept it, so we strip the
 * sampling params centrally for the adaptive-only models rather than touching
 * every call site.
 */
export function isAdaptiveOnlyModel(internalModelId: string): boolean {
  return (
    /^claude-opus-4-(?:[7-9]|\d\d)/.test(internalModelId) ||
    /^claude-(?:opus|sonnet)-5/.test(internalModelId) ||
    /^claude-(?:fable|mythos)-/.test(internalModelId)
  );
}

const stripSamplingMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) => {
    const next = { ...params };
    delete next.temperature;
    delete next.topP;
    delete next.topK;
    return next;
  },
};

type ProviderModel = Parameters<typeof wrapLanguageModel>[0]["model"];

function track(model: ProviderModel, costKey: string, stripSampling = false): ProviderModel {
  // Order matters: replay sits INNERMOST (last) so usage middleware still
  // observes replayed results and cost attribution works in replay mode.
  // The replay middleware is a passthrough until the harness configures it
  // (see lib/llm/replay.ts).
  return wrapLanguageModel({
    model,
    middleware: stripSampling
      ? [stripSamplingMiddleware, usageMiddleware(costKey), llmReplayMiddleware(costKey)]
      : [usageMiddleware(costKey), llmReplayMiddleware(costKey)],
  });
}

/**
 * Per-provider capabilities the routes need — previously each route
 * hand-maintained its own provider list and they drifted: Ask skipped
 * Claude model-ID validation for ollama/openai-compatible but NOT mlx/
 * llama-cpp (whose Ask requests silently fell back to Claude IDs), while
 * Investigate's local-provider refusal listed mlx/llama-cpp but not
 * openai-compatible. Adding a provider now means adding one entry here.
 */
export function providerCapabilities(provider: LLMProviderId): {
  /** Model ids are provider-native, not Claude ids — skip Claude validation. */
  skipModelValidation: boolean;
  /** Local backends plan/synthesize multi-step investigations poorly. */
  supportsInvestigate: boolean;
} {
  switch (provider) {
    case "anthropic":
    case "claude-cli":
    case "bedrock":
    case "vertex":
      // claude-cli fronts the same frontier Claude models via real Claude IDs,
      // so Claude model-ID validation applies and Investigate is fully supported.
      return { skipModelValidation: false, supportsInvestigate: true };
    case "openai-compatible":
      // A user-configured endpoint may front a capable cloud model —
      // Investigate stays allowed (the pre-existing behavior).
      return { skipModelValidation: true, supportsInvestigate: true };
    case "mlx":
    case "llama-cpp":
    case "ollama":
      return { skipModelValidation: true, supportsInvestigate: false };
  }
}

export function getModel(internalModelId: string) {
  const provider = getActiveProvider();
  const client = createProviderClient(provider);
  const cloudAnthropic =
    provider === "anthropic" || provider === "bedrock" || provider === "vertex";

  // OpenAI-compatible uses a single user-configured model for all calls
  if (provider === "openai-compatible") {
    const model = openaiModel();
    if (!model) {
      throw new Error(
        "A model is required for the openai-compatible provider — set it in Settings " +
          "(runtime-config providers.openaiModel) or via OPENAI_MODEL."
      );
    }
    return track(client(model), model);
  }

  // Local backends use the active model from runtime config
  if (provider === "mlx") {
    const rc = getRuntimeConfig();
    const model = rc.mlx?.activeModel;
    if (!model) throw new Error("No MLX model selected. Choose a model in Settings.");
    return track(client(model), model);
  }
  if (provider === "llama-cpp") {
    const rc = getRuntimeConfig();
    const model = rc.llamaCpp?.activeModel;
    if (!model) throw new Error("No llama.cpp model selected. Choose a model in Settings.");
    return track(client(model), model);
  }
  if (provider === "ollama") {
    const rc = getRuntimeConfig();
    const model = rc.ollama?.activeModel;
    if (!model) throw new Error("No Ollama model selected. Choose a model in Settings.");
    return track(client(model), model);
  }

  // Claude CLI: real Claude models (honor per-task model choice via MODEL_MAP).
  // Price token usage at the EQUIVALENT API rate by keying cost on the internal
  // model id (a MODEL_PRICING key), exactly like the direct Anthropic provider.
  // The CLI is not necessarily flat-rate: an org may run it on API / consumption
  // billing where these tokens are metered, so the equivalent-API-cost figure is
  // the honest one to surface — not $0. No sampling strip (our fetch ignores
  // sampling params and the CLI manages thinking itself).
  //
  // Cache reads are priced at the cheap cache-read rate (the transport surfaces
  // them via input_tokens_details.cached_tokens). Cache-CREATION tokens fold
  // into the input bucket and price at the input rate — the OpenAI-Responses
  // usage shape has no cache-write bucket — so the figure slightly under-counts
  // the write premium. It's a close equivalent-cost estimate, not a bill.
  if (provider === "claude-cli") {
    const mapped = MODEL_MAP["claude-cli"][internalModelId] ?? internalModelId;
    return track(client(mapped), internalModelId);
  }

  const mappedId = MODEL_MAP[provider][internalModelId] ?? internalModelId;
  const stripSampling = cloudAnthropic && isAdaptiveOnlyModel(internalModelId);
  return track(client(mappedId), cloudAnthropic ? internalModelId : mappedId, stripSampling);
}

/**
 * Wrap a static system prompt for Anthropic prompt caching (~90% input discount
 * on cache hits, 5-min TTL). Use for LARGE, stable system prompts that are
 * re-sent across many calls — the code-gen system prompt and the JSON-render
 * catalog prompt, which an Investigate run re-sends on every sub-question / cell
 * compose / retry. Only applied for the direct Anthropic provider; other
 * providers (bedrock/vertex/local) use a different or no cache mechanism, so we
 * return the plain string to keep their behavior unchanged.
 *
 * TTL is 1 hour, not the 5-minute default: an Investigate run fans out over
 * several MINUTES (planner → waves of sub-questions → cell composes → final
 * compose), so a 5m entry written early expires before later calls read it —
 * we were paying to write caches that never got read. 1h keeps the schema /
 * catalog warm for the whole run (and across conversational Ask follow-ups on
 * the same dataset). The write costs 2× vs 1.25×, but reads vastly outnumber
 * writes here, so it's a large net win.
 */
const CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

export function cachedSystem(content: string): string | SystemModelMessage {
  if (getActiveProvider() !== "anthropic") return content;
  return {
    role: "system",
    content,
    providerOptions: { anthropic: { cacheControl: CACHE_CONTROL } },
  };
}

/**
 * A user-message TEXT content part with a cache breakpoint after it (Anthropic
 * only). Use to cache a large, stable PREFIX inside the user prompt — e.g. the
 * dataset schema, which is identical across an Investigate run's N sub-questions
 * and code-gen retries. The variable tail (the question) follows as a separate,
 * uncached text part. Returns a plain text part for non-Anthropic providers.
 */
export function cachedText(text: string): TextPart {
  if (getActiveProvider() !== "anthropic") return { type: "text", text };
  return {
    type: "text",
    text,
    providerOptions: { anthropic: { cacheControl: CACHE_CONTROL } },
  };
}

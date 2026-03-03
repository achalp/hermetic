import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createVertex } from "@ai-sdk/google-vertex";
import { createOpenAI } from "@ai-sdk/openai";
import { OLLAMA_NUM_CTX } from "@/lib/constants";
import type { LLMProviderId } from "@/lib/constants";
import { getRuntimeConfig } from "@/lib/runtime-config";

/**
 * Extract plain-text content from an OpenAI Responses API message.
 * Handles both string content and array-of-blocks content.
 */
function extractContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: Record<string, unknown>) => {
        if (block.type === "input_text" || block.type === "text") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Custom fetch for Ollama: intercepts SDK requests (Responses API or
 * Chat Completions) and redirects them to Ollama's native /api/chat
 * endpoint which supports options.num_ctx. Translates the response back
 * to whichever format the SDK originally requested.
 */
function ollamaFetch(baseUrl: string) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    const isResponses = url.includes("/responses");
    const isChatCompletions = url.includes("/chat/completions");

    if ((!isResponses && !isChatCompletions) || !init?.body) {
      return globalThis.fetch(input, init);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body as string);
    } catch {
      return globalThis.fetch(input, init);
    }

    const isStreaming = body.stream === true;

    // Convert messages from either format to Ollama's native format
    const rawMessages = (body.input ?? body.messages ?? []) as Array<Record<string, unknown>>;
    const messages = rawMessages.map((m) => ({
      role: m.role as string,
      content: extractContent(m.content),
    }));

    const ollamaBody = {
      model: body.model,
      messages,
      stream: isStreaming,
      options: {
        num_ctx: OLLAMA_NUM_CTX,
        ...(body.temperature != null && { temperature: body.temperature }),
      },
    };

    const ollamaRes = await globalThis.fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaBody),
    });

    if (!ollamaRes.ok || !ollamaRes.body) {
      return ollamaRes;
    }

    // --- Responses API format ---
    if (isResponses) {
      if (!isStreaming) {
        const data = await ollamaRes.json();
        const ts = Math.floor(Date.now() / 1000);
        return new Response(
          JSON.stringify({
            id: `resp_${ts}`,
            object: "response",
            created_at: ts,
            completed_at: ts,
            status: "completed",
            model: body.model,
            output: [
              {
                id: `msg_${ts}`,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: data.message?.content ?? "",
                    annotations: [],
                  },
                ],
              },
            ],
            usage: {
              input_tokens: data.prompt_eval_count ?? 0,
              output_tokens: data.eval_count ?? 0,
              total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      // Streaming Responses API: Ollama NDJSON → SSE events
      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const ts = Math.floor(Date.now() / 1000);
      const respId = `resp_${ts}`;
      const msgId = `msg_${ts}`;

      const readable = new ReadableStream({
        async start(controller) {
          let seq = 0;
          const emit = (event: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          };

          const baseResponse = {
            id: respId,
            object: "response",
            status: "in_progress",
            model: body.model,
            output: [],
          };

          emit("response.created", {
            type: "response.created",
            sequence_number: seq++,
            response: baseResponse,
          });
          emit("response.in_progress", {
            type: "response.in_progress",
            sequence_number: seq++,
            response: baseResponse,
          });
          emit("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: seq++,
            output_index: 0,
            item: {
              id: msgId,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          });
          emit("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: seq++,
            output_index: 0,
            content_index: 0,
            item_id: msgId,
            part: { type: "output_text", text: "", annotations: [], logprobs: [] },
          });

          let buffer = "";
          let fullText = "";

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const chunk = JSON.parse(line);
                  const content = chunk.message?.content ?? "";
                  if (content) {
                    fullText += content;
                    emit("response.output_text.delta", {
                      type: "response.output_text.delta",
                      sequence_number: seq++,
                      output_index: 0,
                      content_index: 0,
                      item_id: msgId,
                      delta: content,
                      logprobs: [],
                    });
                  }
                } catch {
                  /* skip */
                }
              }
            }
          } catch {
            /* stream ended */
          }

          const doneItem = {
            id: msgId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: fullText, annotations: [], logprobs: [] }],
          };

          emit("response.output_text.done", {
            type: "response.output_text.done",
            sequence_number: seq++,
            output_index: 0,
            content_index: 0,
            item_id: msgId,
            text: fullText,
          });
          emit("response.content_part.done", {
            type: "response.content_part.done",
            sequence_number: seq++,
            output_index: 0,
            content_index: 0,
            item_id: msgId,
            part: { type: "output_text", text: fullText, annotations: [], logprobs: [] },
          });
          emit("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: seq++,
            output_index: 0,
            item: doneItem,
          });
          emit("response.completed", {
            type: "response.completed",
            sequence_number: seq++,
            response: {
              ...baseResponse,
              status: "completed",
              output: [doneItem],
            },
          });

          controller.close();
        },
      });

      return new Response(readable, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
      });
    }

    // --- Chat Completions format (legacy fallback) ---
    if (!isStreaming) {
      const data = await ollamaRes.json();
      return new Response(
        JSON.stringify({
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: data.message?.content ?? "" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: data.prompt_eval_count ?? 0,
            completion_tokens: data.eval_count ?? 0,
            total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Streaming chat completions: Ollama NDJSON → OpenAI SSE
    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const readable = new ReadableStream({
      async pull(controller) {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const chunk = JSON.parse(line);
              const sseData = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [
                  {
                    index: 0,
                    delta: chunk.done ? {} : { content: chunk.message?.content ?? "" },
                    finish_reason: chunk.done ? "stop" : null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(sseData)}\n\n`));
            } catch {
              /* skip */
            }
          }
        }
      },
    });

    return new Response(readable, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  };
}

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
export function getActiveProvider(): LLMProviderId {
  const explicit = process.env.LLM_PROVIDER;
  if (explicit) {
    const normalized = explicit.toLowerCase() as LLMProviderId;
    if (!["anthropic", "bedrock", "vertex", "openai-compatible", "ollama"].includes(normalized)) {
      throw new Error(
        `Invalid LLM_PROVIDER "${explicit}". Must be one of: anthropic, bedrock, vertex, openai-compatible, ollama`
      );
    }
    return normalized;
  }

  // Check runtime config for Ollama — user explicitly enabled in UI,
  // so it takes priority over auto-detected env var credentials
  const rc = getRuntimeConfig();
  if (rc.ollama?.enabled && rc.ollama.activeModel) {
    return "ollama";
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
      "Or set LLM_PROVIDER explicitly, or enable Ollama in Settings."
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
    case "ollama": {
      const rc = getRuntimeConfig();
      const baseUrl = rc.ollama?.baseUrl || "http://localhost:11434";
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

  // Ollama uses the active model from runtime config
  if (provider === "ollama") {
    const rc = getRuntimeConfig();
    const model = rc.ollama?.activeModel;
    if (!model) {
      throw new Error("No Ollama model selected. Choose a model in Settings.");
    }
    return client(model);
  }

  const mappedId = MODEL_MAP[provider][internalModelId] ?? internalModelId;
  return client(mappedId);
}

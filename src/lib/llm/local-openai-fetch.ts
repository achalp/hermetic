/**
 * OpenAI-compatible transport shims for local LLM backends.
 *
 * ollamaFetch and localOpenAIFetch intercept the AI SDK's Responses/Chat
 * requests and redirect them to a local server's native endpoint (Ollama's
 * /api/chat with num_ctx, or an MLX/llama.cpp /v1/chat/completions), then
 * translate the reply back to the format the SDK expects. Extracted from
 * client.ts (L7) so the provider client factory stays small; the SSE/JSON
 * framing helpers live in local-transport.ts.
 */
import { LOCAL_CTX_SIZE } from "@/lib/constants";
import {
  responsesJSON,
  responsesSSE,
  ollamaDelta,
  openAISSEDelta,
  extractMessageText,
} from "@/lib/llm/local-transport";
import { logger, errMessage } from "@/lib/logger";

/**
 * Custom fetch for Ollama: intercepts SDK requests (Responses API or
 * Chat Completions) and redirects them to Ollama's native /api/chat
 * endpoint which supports options.num_ctx. Translates the response back
 * to whichever format the SDK originally requested.
 */
export function ollamaFetch(baseUrl: string) {
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
      content: extractMessageText(m.content),
    }));

    const ollamaBody = {
      model: body.model,
      messages,
      stream: isStreaming,
      options: {
        num_ctx: LOCAL_CTX_SIZE,
        ...(body.temperature != null && { temperature: body.temperature }),
      },
    };

    let ollamaRes: Response;
    try {
      ollamaRes = await globalThis.fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ollamaBody),
      });
    } catch (err) {
      const errDetail = errMessage(err);
      logger.error("ollamaFetch connection error", { error: errDetail });
      return new Response(
        JSON.stringify({
          error: {
            message: "Ollama server crashed or is unreachable. Check that Ollama is running.",
            type: "connection_error",
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text().catch(() => "");
      let errMsg: string;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error ?? errText;
      } catch {
        errMsg = errText || `Ollama returned HTTP ${ollamaRes.status}`;
      }
      return new Response(
        JSON.stringify({
          error: { message: errMsg, type: "server_error", code: ollamaRes.status },
        }),
        { status: ollamaRes.status, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!ollamaRes.body) {
      return ollamaRes;
    }

    // --- Responses API format (shared translation — see local-transport.ts) ---
    if (isResponses) {
      if (!isStreaming) {
        const data = await ollamaRes.json();
        return responsesJSON(body.model, data.message?.content ?? "", {
          inputTokens: data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count ?? 0,
        });
      }
      // Ollama NDJSON → Responses SSE. Via the shared synthesizer, this path
      // now ALSO gets the stall-timeout + error-as-text hardening it lacked
      // (its old copy silently swallowed stream errors).
      return responsesSSE({
        upstream: ollamaRes.body,
        model: body.model,
        deltaFromLine: ollamaDelta,
        backend: "ollama",
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

/** Timeout for initial connection + response headers from local LLM server.
 *  Large models (e.g. 30B on CPU) can take 5+ minutes for first response.
 *  (The per-chunk stall budget lives in local-transport.ts with the shared
 *  stream synthesizer.) */
const LOCAL_REQUEST_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/**
 * Custom fetch for local OpenAI-compatible servers (MLX, llama.cpp):
 * intercepts SDK requests to /responses and redirects them to
 * /v1/chat/completions (which these servers support), translating the
 * response back to the Responses API format the SDK expects.
 */
export function localOpenAIFetch(baseUrl: string) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (!url.includes("/responses") || !init?.body) {
      logger.debug("localOpenAIFetch passthrough", { url });
      return globalThis.fetch(input, init);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(init.body as string);
    } catch {
      return globalThis.fetch(input, init);
    }

    const isStreaming = body.stream === true;

    // Convert Responses API input to Chat Completions messages
    const rawMessages = (body.input ?? []) as Array<Record<string, unknown>>;
    const messages = rawMessages.map((m) => ({
      role: m.role as string,
      content: extractMessageText(m.content),
    }));

    // Add system instructions if present
    if (body.instructions) {
      messages.unshift({ role: "system", content: body.instructions as string });
    }

    const ccBody: Record<string, unknown> = {
      model: body.model,
      messages,
      stream: isStreaming,
    };
    if (body.temperature != null) ccBody.temperature = body.temperature;
    if (body.max_output_tokens != null) ccBody.max_tokens = body.max_output_tokens;

    logger.debug("localOpenAIFetch → chat/completions", {
      model: ccBody.model,
      stream: isStreaming,
      messages: (messages as Array<{ role: string; content: string }>).length,
    });

    // Use AbortController with timeout to prevent hanging requests.
    // MLX server can hang when overloaded or during model loading.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_REQUEST_TIMEOUT_MS);

    let ccRes: Response;
    try {
      ccRes = await globalThis.fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ccBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      const errDetail = errMessage(err);
      const isAborted = err instanceof Error && err.name === "AbortError";
      const isConnRefused =
        err instanceof Error &&
        (err.message.includes("ECONNREFUSED") || err.message.includes("ECONNRESET"));

      // Node's fetch wraps the real error in .cause — log it for debugging
      const cause =
        err instanceof Error && "cause" in err
          ? ((err.cause as Error)?.message ?? err.cause)
          : undefined;
      logger.error("localOpenAIFetch connection error", {
        error: errDetail,
        cause,
        isAborted,
        isConnRefused,
      });

      let msg: string;
      if (isAborted) {
        msg =
          "Local LLM server did not respond in time. " +
          "The model may be too large or the server may be hung. Try restarting in Settings.";
      } else if (isConnRefused) {
        msg =
          "Local LLM server is not running. It may have crashed (out of memory) or was stopped. " +
          "Restart it in Settings, or try a smaller model.";
      } else {
        msg = `Local LLM request failed: ${errDetail}` + (cause ? ` (${cause})` : "");
      }

      // Use 422 (not 5xx) so the AI SDK does NOT retry — a crashed/hung server
      // won't recover on its own and retrying just wastes time.
      return new Response(JSON.stringify({ error: { message: msg, type: "connection_error" } }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Clear the connection timeout (response headers received)
    clearTimeout(timeout);

    logger.debug("localOpenAIFetch response", { status: ccRes.status, ok: ccRes.ok });

    if (!ccRes.ok) {
      const errText = await ccRes.text().catch(() => "");
      let errMsg: string;

      // Handle local server error codes (MLX and llama.cpp)
      if (ccRes.status === 503) {
        // llama-server returns 503 when all slots are busy or model is still loading.
        // MLX returns 503 during model load. Either way, it's a transient condition.
        errMsg =
          "Local LLM server is busy (all inference slots occupied, or model still loading). " +
          "Wait for the current request to finish, then try again.";
      } else if (ccRes.status === 429) {
        errMsg =
          "Local LLM server is overloaded. Wait for the current request to finish before sending another.";
      } else {
        try {
          const errJson = JSON.parse(errText);
          errMsg = errJson.error?.message ?? errJson.error ?? errText;
        } catch {
          errMsg = errText || `Local LLM server returned HTTP ${ccRes.status}`;
        }
      }

      return new Response(
        JSON.stringify({ error: { message: errMsg, type: "server_error", code: ccRes.status } }),
        { status: ccRes.status, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!ccRes.body) return ccRes;

    // --- Non-streaming: translate Chat Completion → Responses API ---
    if (!isStreaming) {
      const rawText = await ccRes.text();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(rawText);
      } catch {
        logger.error("localOpenAIFetch: non-JSON response from LLM", {
          body: rawText.slice(0, 500),
        });
        return new Response(
          JSON.stringify({
            error: {
              message: `Local LLM returned non-JSON response: ${rawText.slice(0, 200)}`,
              type: "parse_error",
            },
          }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }
      const d = data as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const text = d.choices?.[0]?.message?.content ?? "";
      logger.debug("localOpenAIFetch response text", { chars: text.length });
      return responsesJSON(body.model, text, {
        inputTokens: d.usage?.prompt_tokens ?? 0,
        outputTokens: d.usage?.completion_tokens ?? 0,
        totalTokens: d.usage?.total_tokens ?? 0,
      });
    }

    // --- Streaming: OpenAI SSE → Responses SSE (shared — local-transport.ts) ---
    return responsesSSE({
      upstream: ccRes.body,
      model: body.model,
      deltaFromLine: openAISSEDelta,
      backend: "local-openai",
    });
  };
}

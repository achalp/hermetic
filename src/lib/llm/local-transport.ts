/**
 * Shared Responses-API translation for the local-backend fetch shims.
 *
 * Both ollamaFetch (NDJSON upstream) and localOpenAIFetch (OpenAI SSE
 * upstream) synthesize the SAME Responses-API surface the AI SDK expects:
 * a non-streaming response envelope, and the 8-event SSE choreography
 * (created → in_progress → output_item.added → content_part.added →
 * N output_text.delta → output_text.done → content_part.done →
 * output_item.done → completed). That ~250-line synthesis was copy-pasted
 * in both shims and had drifted: only localOpenAIFetch had the stall-timeout
 * and error-as-text hardening; ollamaFetch silently swallowed stream errors.
 *
 * It lives here once. The shims keep what genuinely differs — endpoint,
 * request-body shape, connection-error mapping — and pass a `deltaFromLine`
 * adapter describing how to pull a text delta out of one upstream line.
 * BOTH now get the hardening (drift resolved toward the stronger copy).
 */
import { logger, errMessage } from "@/lib/logger";

/** Stall budget between upstream reads — a hung local server, not a slow one. */
export const LOCAL_STREAM_STALL_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export interface ResponsesUsage {
  /** TOTAL prompt tokens, including any served from cache. */
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  /**
   * Portion of `inputTokens` read from cache. Emitted as
   * `input_tokens_details.cached_tokens`, which the OpenAI-Responses provider
   * maps to the `cacheRead` bucket (`noCache = input − cached`) so the cost
   * accumulator prices it at the cheap cache-read rate instead of full input.
   */
  cachedInputTokens?: number;
}

/**
 * Extract plain-text content from an OpenAI Responses/Chat message `content`
 * field, which the AI SDK sends as either a bare string or an array of typed
 * blocks (`input_text` / `text`). Shared by every non-HTTP backend shim
 * (ollama, local-openai, claude-cli) that has to flatten SDK messages before
 * handing them to a different transport.
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const b = block as Record<string, unknown>;
        if (b.type === "input_text" || b.type === "text") return (b.text as string) ?? "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Shape the completed-event `usage` field mirrors (Responses-API token buckets). */
interface ResponsesUsageBlock {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
}

function usageBlock(usage: ResponsesUsage): ResponsesUsageBlock {
  const block: ResponsesUsageBlock = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
  };
  // Only emit the detail when there are cached reads — keeps the envelope of
  // cache-less backends (ollama/local-openai) byte-identical to before.
  if (usage.cachedInputTokens && usage.cachedInputTokens > 0) {
    block.input_tokens_details = { cached_tokens: usage.cachedInputTokens };
  }
  return block;
}

/** Non-streaming Responses-API envelope around a completed text. */
export function responsesJSON(model: unknown, text: string, usage: ResponsesUsage): Response {
  const ts = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      id: `resp_${ts}`,
      object: "response",
      created_at: ts,
      completed_at: ts,
      status: "completed",
      model,
      output: [
        {
          id: `msg_${ts}`,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: usageBlock(usage),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Translate a newline-delimited upstream body into Responses-API SSE.
 *
 * `deltaFromLine` receives each non-empty trimmed upstream line and returns
 * the text delta it carries (null/"" to skip) — the ONLY format-specific
 * piece. Throwing inside it is treated as a skippable malformed line.
 *
 * Hardening (now for every local backend): each read races a stall timeout,
 * and a mid-stream failure (stall, crash, reset) is surfaced as readable
 * error TEXT in the output when nothing was generated — so the user sees the
 * cause instead of an empty result.
 */
export function responsesSSE(opts: {
  upstream: ReadableStream<Uint8Array>;
  model: unknown;
  deltaFromLine: (trimmedLine: string) => string | null | undefined;
  /** Label for the stream-error log ("ollama" | "local-openai" | "claude-cli"). */
  backend: string;
  stallTimeoutMs?: number;
  /**
   * Optional per-line usage extractor. Backends whose stream carries a terminal
   * usage record (e.g. claude-cli's `result` event) return it here; the last
   * non-null value is attached to `response.completed.response.usage` so the AI
   * SDK — and our usage middleware — can track token spend on streamed calls.
   * Streams without a usage line (ollama/local-openai) simply omit it. Throwing
   * is treated as a skippable line, same contract as `deltaFromLine`.
   */
  usageFromLine?: (trimmedLine: string) => ResponsesUsage | null | undefined;
}): Response {
  const { upstream, model, deltaFromLine, usageFromLine, backend } = opts;
  const stallTimeoutMs = opts.stallTimeoutMs ?? LOCAL_STREAM_STALL_TIMEOUT_MS;

  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const ts = Math.floor(Date.now() / 1000);
  const respId = `resp_${ts}`;
  const msgId = `msg_${ts}`;

  const readable = new ReadableStream({
    async start(controller) {
      let seq = 0;
      const emit = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const baseResponse = {
        id: respId,
        object: "response",
        status: "in_progress",
        model,
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
        item: { id: msgId, type: "message", status: "in_progress", role: "assistant", content: [] },
      });
      emit("response.content_part.added", {
        type: "response.content_part.added",
        sequence_number: seq++,
        output_index: 0,
        content_index: 0,
        item_id: msgId,
        part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      });

      const emitDelta = (delta: string) => {
        emit("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: seq++,
          output_index: 0,
          content_index: 0,
          item_id: msgId,
          delta,
          logprobs: [],
        });
      };

      let buffer = "";
      let fullText = "";
      let streamError: string | null = null;
      let capturedUsage: ResponsesUsage | null = null;

      try {
        while (true) {
          // Read with a stall timeout — no data for the whole budget means the
          // server is hung (common MLX/Ollama failure mode with large prompts
          // or OOM), and waiting forever just hangs the analysis. The timer is
          // cleared the instant the read wins the race — otherwise every read
          // leaves a live 5-minute timer behind (thousands per generation).
          let stallTimer: ReturnType<typeof setTimeout> | undefined;
          const readResult = await (async () => {
            try {
              return await Promise.race([
                reader.read(),
                new Promise<never>((_, reject) => {
                  stallTimer = setTimeout(
                    () =>
                      reject(
                        new Error(`Stream stalled — no data received for ${stallTimeoutMs / 1000}s`)
                      ),
                    stallTimeoutMs
                  );
                }),
              ]);
            } finally {
              clearTimeout(stallTimer);
            }
          })();
          const { done, value } = readResult;
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let delta: string | null | undefined;
            try {
              delta = deltaFromLine(trimmed);
            } catch {
              continue; // malformed upstream line — skip
            }
            if (delta) {
              fullText += delta;
              emitDelta(delta);
            }
            if (usageFromLine) {
              try {
                const u = usageFromLine(trimmed);
                if (u) capturedUsage = u;
              } catch {
                // malformed line for usage purposes — already handled for deltas
              }
            }
          }
        }
      } catch (err) {
        // Stream interrupted — server crashed, stalled, or OOM'd.
        const errMsg = errMessage(err);
        logger.error("Local LLM stream error", {
          backend,
          error: errMsg,
          textSoFar: fullText.length,
        });

        if (errMsg.includes("Stream stalled")) {
          streamError =
            "\n\n[Server stopped responding. It may be overloaded or out of memory. Try a smaller model or shorter prompt.]";
        } else if (errMsg.includes("ECONNRESET") || errMsg.includes("terminated")) {
          streamError =
            "\n\n[Server crashed during inference — the model may be too large for available memory. Try a smaller model.]";
        } else {
          streamError = `\n\n[Stream interrupted: ${errMsg}]`;
        }
        reader.cancel().catch(() => {});
      }

      // A stream that errored AFTER emitting partial output is a TRUNCATION, not
      // a success: a half-written Python script still parses and would execute; a
      // truncated JSONL spec silently drops its conclusion. Presenting that as
      // "completed" is the bug (finding 05). Distinguish it from the no-output
      // case, which legitimately completes with the error text as its whole body.
      // Non-null ⇒ the stream produced partial output and THEN failed (truncation).
      const truncationText: string | null =
        streamError !== null && fullText.length > 0 ? streamError : null;

      if (streamError && !fullText) {
        // No output generated — emit the error as text so the user sees it. This
        // IS the whole response, not a fragment, so it still completes normally.
        fullText = streamError.trim();
        emitDelta(fullText);
      } else if (truncationText !== null) {
        // Keep the partial text in the done events but append the failure reason.
        emitDelta(truncationText);
        fullText += truncationText;
      }

      const doneItem = {
        id: msgId,
        type: "message",
        status: truncationText !== null ? "incomplete" : "completed",
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

      if (truncationText !== null) {
        // Two signals, belt and suspenders: an `error` chunk makes the AI SDK
        // reject the stream (the `await result.text` in code-generation throws,
        // so the truncated script never executes and the caller's retry path
        // engages), and a terminal `response.failed` marks the run's finish
        // reason as error instead of the misleading "completed".
        const reason = truncationText.trim();
        emit("error", {
          type: "error",
          sequence_number: seq++,
          error: { type: "stream_truncated", code: "stream_truncated", message: reason },
        });
        emit("response.failed", {
          type: "response.failed",
          sequence_number: seq++,
          response: {
            ...baseResponse,
            status: "failed",
            output: [doneItem],
            error: { code: "stream_truncated", message: reason },
            ...(capturedUsage ? { usage: usageBlock(capturedUsage) } : {}),
          },
        });
      } else {
        emit("response.completed", {
          type: "response.completed",
          sequence_number: seq++,
          response: {
            ...baseResponse,
            status: "completed",
            output: [doneItem],
            ...(capturedUsage ? { usage: usageBlock(capturedUsage) } : {}),
          },
        });
      }

      controller.close();
    },
  });

  return new Response(readable, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

/** Delta extractor for Ollama's native NDJSON lines. */
export function ollamaDelta(trimmedLine: string): string | null {
  const chunk = JSON.parse(trimmedLine);
  return chunk.message?.content ?? null;
}

/** Delta extractor for OpenAI-style SSE `data:` lines. */
export function openAISSEDelta(trimmedLine: string): string | null {
  if (trimmedLine === "data: [DONE]") return null;
  const jsonStr = trimmedLine.startsWith("data: ") ? trimmedLine.slice(6) : trimmedLine;
  const chunk = JSON.parse(jsonStr);
  return chunk.choices?.[0]?.delta?.content ?? null;
}

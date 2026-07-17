/**
 * Tests for the shared local-backend Responses-API translation — the ~250
 * lines previously copy-pasted (and drifted) between ollamaFetch and
 * localOpenAIFetch with zero coverage.
 */
import { describe, it, expect } from "vitest";
import {
  responsesJSON,
  responsesSSE,
  ollamaDelta,
  openAISSEDelta,
  extractMessageText,
} from "@/lib/llm/local-transport";

function upstreamOf(
  chunks: string[],
  opts: { failAfter?: Error } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else if (opts.failAfter) {
        controller.error(opts.failAfter);
      } else {
        controller.close();
      }
    },
  });
}

interface SSEEvent {
  event: string;
  data: Record<string, unknown>;
}

async function readSSE(res: Response): Promise<SSEEvent[]> {
  const text = await res.text();
  const events: SSEEvent[] = [];
  for (const block of text.split("\n\n")) {
    const eventMatch = block.match(/^event: (.+)$/m);
    const dataMatch = block.match(/^data: (.+)$/m);
    if (eventMatch && dataMatch) {
      events.push({ event: eventMatch[1], data: JSON.parse(dataMatch[1]) });
    }
  }
  return events;
}

const fullTextOf = (events: SSEEvent[]) =>
  (events.find((e) => e.event === "response.output_text.done")?.data.text as string) ?? "";

describe("responsesJSON", () => {
  it("builds the completed envelope with usage", async () => {
    const res = responsesJSON("qwen", "hello", { inputTokens: 10, outputTokens: 5 });
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.output[0].content[0]).toMatchObject({ type: "output_text", text: "hello" });
    expect(body.usage).toEqual({ input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });
});

describe("responsesSSE — event choreography", () => {
  it("emits the full 8-event sequence with monotonic sequence numbers", async () => {
    const upstream = upstreamOf([
      '{"message":{"content":"Hel"}}\n',
      '{"message":{"content":"lo"}}\n',
    ]);
    const res = responsesSSE({ upstream, model: "m", deltaFromLine: ollamaDelta, backend: "test" });
    const events = await readSSE(res);
    expect(events.map((e) => e.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const seqs = events.map((e) => e.data.sequence_number as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(fullTextOf(events)).toBe("Hello");
  });

  it("reassembles deltas split across chunk boundaries (partial upstream lines)", async () => {
    const upstream = upstreamOf([
      '{"message":{"con',
      'tent":"abc"}}\n{"message":{"content":"def"}}\n',
    ]);
    const res = responsesSSE({ upstream, model: "m", deltaFromLine: ollamaDelta, backend: "test" });
    expect(fullTextOf(await readSSE(res))).toBe("abcdef");
  });

  it("skips malformed upstream lines instead of dying", async () => {
    const upstream = upstreamOf(["not json at all\n", '{"message":{"content":"ok"}}\n']);
    const res = responsesSSE({ upstream, model: "m", deltaFromLine: ollamaDelta, backend: "test" });
    expect(fullTextOf(await readSSE(res))).toBe("ok");
  });

  it("surfaces a mid-stream crash as readable error text (the hardening ollama lacked)", async () => {
    const upstream = upstreamOf([], { failAfter: new Error("fetch failed: ECONNRESET") });
    const res = responsesSSE({ upstream, model: "m", deltaFromLine: ollamaDelta, backend: "test" });
    const events = await readSSE(res);
    // Choreography still completes cleanly…
    expect(events.at(-1)?.event).toBe("response.completed");
    // …and the failure reason reaches the user as output text.
    expect(fullTextOf(events)).toContain("Server crashed during inference");
  });

  it("stall timeout fires with the actual budget in the message", async () => {
    // An upstream that never yields → the race rejects at the (tiny) budget.
    const upstream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const res = responsesSSE({
      upstream,
      model: "m",
      deltaFromLine: ollamaDelta,
      backend: "test",
      stallTimeoutMs: 50,
    });
    const events = await readSSE(res);
    expect(fullTextOf(events)).toContain("Server stopped responding");
    expect(events.at(-1)?.event).toBe("response.completed");
  });
});

describe("extractMessageText", () => {
  it("returns a bare string content unchanged", () => {
    expect(extractMessageText("hello")).toBe("hello");
  });

  it("joins input_text / text blocks and drops the rest", () => {
    expect(
      extractMessageText([
        { type: "input_text", text: "a" },
        { type: "text", text: "b" },
        { type: "image", url: "x" },
      ])
    ).toBe("a\nb");
  });

  it("returns empty string for unknown content shapes", () => {
    expect(extractMessageText(undefined)).toBe("");
    expect(extractMessageText({ role: "user" })).toBe("");
  });
});

describe("responsesSSE — usageFromLine", () => {
  it("attaches captured usage to the completed event", async () => {
    const upstream = upstreamOf([
      '{"message":{"content":"hi"}}\n',
      '{"done":true,"usage":{"in":5,"out":2}}\n',
    ]);
    const res = responsesSSE({
      upstream,
      model: "m",
      deltaFromLine: ollamaDelta,
      usageFromLine: (line) => {
        const o = JSON.parse(line);
        return o.usage ? { inputTokens: o.usage.in, outputTokens: o.usage.out } : null;
      },
      backend: "test",
    });
    const events = await readSSE(res);
    const completed = events.find((e) => e.event === "response.completed");
    expect((completed?.data.response as { usage?: unknown }).usage).toEqual({
      input_tokens: 5,
      output_tokens: 2,
      total_tokens: 7,
    });
  });

  it("omits usage on the completed event when no usageFromLine is provided", async () => {
    const upstream = upstreamOf(['{"message":{"content":"hi"}}\n']);
    const res = responsesSSE({ upstream, model: "m", deltaFromLine: ollamaDelta, backend: "test" });
    const events = await readSSE(res);
    const completed = events.find((e) => e.event === "response.completed");
    expect((completed?.data.response as { usage?: unknown }).usage).toBeUndefined();
  });
});

describe("delta extractors", () => {
  it("ollamaDelta reads NDJSON message content", () => {
    expect(ollamaDelta('{"message":{"content":"hi"}}')).toBe("hi");
    expect(ollamaDelta('{"done":true}')).toBeNull();
    expect(() => ollamaDelta("garbage")).toThrow(); // caller treats throw as skip
  });

  it("openAISSEDelta strips the data: prefix and skips [DONE]", () => {
    expect(openAISSEDelta('data: {"choices":[{"delta":{"content":"hi"}}]}')).toBe("hi");
    expect(openAISSEDelta("data: [DONE]")).toBeNull();
    expect(openAISSEDelta('{"choices":[{"delta":{}}]}')).toBeNull();
  });
});

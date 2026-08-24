import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapLanguageModel } from "ai";
import { configureLLMReplay, llmReplayMiddleware } from "@/lib/llm/replay";

// Minimal fake provider model — enough surface for wrapLanguageModel.
function fakeModel(onGenerate: () => void, onStream: () => void) {
  return {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-model-1",
    supportedUrls: {},
    doGenerate: async () => {
      onGenerate();
      return {
        content: [{ type: "text", text: "generated-answer" }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      };
    },
    doStream: async () => {
      onStream();
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "1", delta: "hello " });
            controller.enqueue({ type: "text-delta", id: "1", delta: "world" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            });
            controller.close();
          },
        }),
      };
    },
  };
}

const PARAMS = {
  prompt: [{ role: "user", content: [{ type: "text", text: "q" }] }],
} as never;

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-replay-test-"));
});
afterEach(() => {
  configureLLMReplay(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("llmReplayMiddleware", () => {
  it("is a passthrough when unconfigured", async () => {
    let calls = 0;
    const model = wrapLanguageModel({
      model: fakeModel(
        () => calls++,
        () => {}
      ) as never,
      middleware: llmReplayMiddleware("test"),
    });
    const result = await model.doGenerate(PARAMS);
    expect(calls).toBe(1);
    expect((result.content[0] as { text: string }).text).toBe("generated-answer");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("records then replays doGenerate without touching the model", async () => {
    let liveCalls = 0;
    const model = wrapLanguageModel({
      model: fakeModel(
        () => liveCalls++,
        () => {}
      ) as never,
      middleware: llmReplayMiddleware("codegen"),
    });

    configureLLMReplay({ mode: "record", dir });
    const recorded = await model.doGenerate(PARAMS);
    expect(liveCalls).toBe(1);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^codegen-[0-9a-f]{16}\.json$/);

    configureLLMReplay({ mode: "replay", dir });
    const replayed = await model.doGenerate(PARAMS);
    expect(liveCalls).toBe(1); // model NOT called again
    expect((replayed.content[0] as { text: string }).text).toBe(
      (recorded.content[0] as { text: string }).text
    );
    expect(replayed.usage).toEqual(recorded.usage);
  });

  it("record mode replays an existing fixture instead of calling live again (record-if-miss)", async () => {
    let liveCalls = 0;
    let liveStreams = 0;
    const model = wrapLanguageModel({
      model: fakeModel(
        () => liveCalls++,
        () => liveStreams++
      ) as never,
      middleware: llmReplayMiddleware("codegen"),
    });

    configureLLMReplay({ mode: "record", dir });
    const first = await model.doGenerate(PARAMS);
    expect(liveCalls).toBe(1);

    // Same request again, STILL in record mode: must serve the fixture. A
    // second live call would get a different answer and overwrite it — any
    // later prompt embedding the first answer then misses forever on replay.
    const second = await model.doGenerate(PARAMS);
    expect(liveCalls).toBe(1);
    expect((second.content[0] as { text: string }).text).toBe(
      (first.content[0] as { text: string }).text
    );

    // Distinct params for the stream half — generate/stream fixtures share
    // the hash-keyed file namespace, and reusing PARAMS would collide with
    // the generate fixture written above (kind-mismatch falls through live).
    const STREAM_PARAMS = {
      prompt: [{ role: "user", content: [{ type: "text", text: "q-stream" }] }],
    } as never;
    const s1 = await model.doStream(STREAM_PARAMS);
    await drain(s1.stream); // recording finalizes when the stream drains
    expect(liveStreams).toBe(1);
    const again = await model.doStream(STREAM_PARAMS);
    expect(liveStreams).toBe(1);
    const chunks = await drain(again.stream);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("records then replays doStream chunk-for-chunk", async () => {
    let liveCalls = 0;
    const model = wrapLanguageModel({
      model: fakeModel(
        () => {},
        () => liveCalls++
      ) as never,
      middleware: llmReplayMiddleware("compose"),
    });

    configureLLMReplay({ mode: "record", dir });
    const recorded = await drain((await model.doStream(PARAMS)).stream);
    expect(liveCalls).toBe(1);
    expect(recorded).toHaveLength(3);

    configureLLMReplay({ mode: "replay", dir });
    const replayed = await drain((await model.doStream(PARAMS)).stream);
    expect(liveCalls).toBe(1);
    expect(replayed).toEqual(recorded);
  });

  it("fails loudly on a replay miss with the request digest", async () => {
    const model = wrapLanguageModel({
      model: fakeModel(
        () => {},
        () => {}
      ) as never,
      middleware: llmReplayMiddleware("codegen"),
    });
    configureLLMReplay({ mode: "replay", dir });
    await expect(model.doGenerate(PARAMS)).rejects.toThrow(
      /LLM replay miss.*codegen.*[Rr]e-record/
    );
  });

  it("different prompts hash to different fixtures", async () => {
    const model = wrapLanguageModel({
      model: fakeModel(
        () => {},
        () => {}
      ) as never,
      middleware: llmReplayMiddleware("t"),
    });
    configureLLMReplay({ mode: "record", dir });
    await model.doGenerate(PARAMS);
    await model.doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "different" }] }],
    } as never);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("hash ignores anthropic cacheControl — fixtures are provider-portable (PR #94)", async () => {
    const { requestHash } = (await import("@/lib/llm/replay")).__testing;
    const plain = {
      maxOutputTokens: 100,
      prompt: [
        { role: "system", content: "sys" },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    };
    const withCache = {
      maxOutputTokens: 100,
      prompt: [
        {
          role: "system",
          content: "sys",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello",
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
            },
          ],
        },
      ],
    };
    expect(requestHash("m", withCache)).toBe(requestHash("m", plain));
    // Non-caching provider options still count toward identity.
    const withThinking = {
      ...plain,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1 } } },
    };
    expect(requestHash("m", withThinking)).not.toBe(requestHash("m", plain));
  });
});

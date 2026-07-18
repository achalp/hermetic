import { describe, it, expect, vi } from "vitest";
import { patchStreamResponse, PATCH_STREAM_HEADERS } from "@/lib/pipeline/patch-stream";

async function readAll(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function makeRequest(): Request {
  return new Request("http://localhost/api/query", { method: "POST" });
}

describe("patchStreamResponse", () => {
  it("sends the canonical anti-buffering header set", () => {
    const res = patchStreamResponse("/api/test", makeRequest(), async () => {});
    for (const [k, v] of Object.entries(PATCH_STREAM_HEADERS)) {
      expect(res.headers.get(k)).toBe(v);
    }
    expect(res.headers.get("Cache-Control")).toContain("no-transform");
  });

  it("wholesale /state add happens exactly once, even for repeated step-1 stages", async () => {
    // Regression: keying the add on `step === 1` clobbered sibling state
    // (__warehouse_csv_id) when the warehouse path emitted several step-1
    // stages (generating_sql → repairing → querying_warehouse).
    const res = patchStreamResponse("/api/test", makeRequest(), async (stream) => {
      stream.emitProgress("generating_sql", 1, 5);
      stream.emitProgress("generating_sql", 1, 5); // repair loop re-emits step 1
      stream.emitProgress("querying_warehouse", 1, 5);
      stream.emitProgress("computing", 2, 5);
    });
    const lines = (await readAll(res))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ op: "add", path: "/state" });
    for (const patch of lines.slice(1)) {
      expect(patch).toMatchObject({ op: "replace", path: "/state/__progress" });
    }
  });

  it("accumulates emittedLines and runs onSettled even when the handler throws", async () => {
    let settledLines: string[] | null = null;
    const res = patchStreamResponse(
      "/api/test",
      makeRequest(),
      async (stream) => {
        stream.emit("line-1\n");
        throw new Error("handler boom");
      },
      async (stream) => {
        settledLines = [...stream.emittedLines];
      }
    );
    // The stream must still terminate cleanly for the client.
    await readAll(res);
    expect(settledLines).not.toBeNull();
    expect(settledLines!).toContain("line-1\n");
  });

  it("keeps accumulating lines after the client disconnects", async () => {
    let captured: string[] = [];
    const res = patchStreamResponse(
      "/api/test",
      makeRequest(),
      async (stream) => {
        stream.emit("before-cancel\n");
        // Give the reader a beat to cancel, then keep emitting.
        await new Promise((r) => setTimeout(r, 20));
        stream.emit("after-cancel\n");
        captured = stream.emittedLines;
      },
      async (stream) => {
        captured = stream.emittedLines;
      }
    );
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(); // client goes away
    // Wait for the handler to finish.
    await vi.waitFor(() => expect(captured.length).toBeGreaterThanOrEqual(2));
    expect(captured).toContain("after-cancel\n");
  });

  it("emits keepalive comment lines while the handler is idle", async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const res = patchStreamResponse("/api/test", makeRequest(), async () => gate);
      const reader = res.body!.getReader();
      await vi.advanceTimersByTimeAsync(16_000);
      release();
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value)).toContain(": keepalive");
    } finally {
      vi.useRealTimers();
    }
  });
});

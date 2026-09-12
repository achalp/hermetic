// @vitest-environment jsdom
/**
 * connectManifest consumes the NDJSON progress stream: {type:"progress"} lines
 * drive the onProgress callback, the final {type:"result"} resolves the view,
 * and {type:"error"} rejects. Added with the connect progress-indicator feature
 * (the silent ~2-min Docker connect that produced double-submitted connects).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { connectManifest } from "@/app/lib/manifest-connect";
import type { ConnectProgress } from "@/lib/manifest/shared";

function streamResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      // Deliberately split across chunk boundaries mid-line to prove the
      // buffering reassembles NDJSON correctly.
      const whole = lines.join("");
      const mid = Math.floor(whole.length / 2);
      controller.enqueue(enc.encode(whole.slice(0, mid)));
      controller.enqueue(enc.encode(whole.slice(mid)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

afterEach(() => vi.restoreAllMocks());

describe("connectManifest — NDJSON progress stream", () => {
  it("delivers each progress phase in order, then resolves the final view", async () => {
    const lines = [
      JSON.stringify({ type: "progress", phase: "fetching", url: "https://h/c.json" }) + "\n",
      JSON.stringify({ type: "progress", phase: "adapting", entities: 3 }) + "\n",
      JSON.stringify({ type: "progress", phase: "extracting", entity: "b", index: 1, total: 3 }) +
        "\n",
      JSON.stringify({ type: "progress", phase: "extracted", entity: "b", ok: true }) + "\n",
      JSON.stringify({ type: "result", view: { manifestId: "m1", title: "Cat", entities: [] } }) +
        "\n",
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(lines)));

    const seen: ConnectProgress[] = [];
    const view = await connectManifest("https://h/c.json", undefined, false, (e) => seen.push(e));

    expect(view).toMatchObject({ manifestId: "m1", title: "Cat" });
    expect(seen.map((e) => e.phase)).toEqual(["fetching", "adapting", "extracting", "extracted"]);
  });

  it("rejects with the streamed error message", async () => {
    const lines = [
      JSON.stringify({ type: "progress", phase: "fetching", url: "u" }) + "\n",
      JSON.stringify({ type: "error", error: "no safe egress host" }) + "\n",
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(lines)));
    await expect(connectManifest("u")).rejects.toThrow(/no safe egress host/);
  });

  it("falls back to JSON parse on a non-OK response (pre-stream error)", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "Local access only" }), { status: 403 })
        )
    );
    await expect(connectManifest("u")).rejects.toThrow(/Local access only/);
  });

  it("throws when the stream ends without a result line", async () => {
    const lines = [JSON.stringify({ type: "progress", phase: "fetching", url: "u" }) + "\n"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(lines)));
    await expect(connectManifest("u")).rejects.toThrow(/without a result/);
  });

  it("falls back to plain JSON when the server returns a non-NDJSON 200 (un-restarted route)", async () => {
    // An old server still returns a single ManifestView as application/json —
    // the content-type guard must parse it directly, not stream-parse it.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ manifestId: "m9", title: "Legacy", entities: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const view = await connectManifest("u");
    expect(view).toMatchObject({ manifestId: "m9", title: "Legacy" });
  });
});

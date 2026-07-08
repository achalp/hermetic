/**
 * NDJSON patch-stream protocol tests — the framing contract between the query
 * routes and the client (the app's most recently buggy area, previously
 * untested end to end).
 *
 * A realistic patch sequence is streamed through the REAL shared scaffold
 * (patchStreamResponse), consumed the way the client consumes it — buffered
 * bytes split on newlines, with the trailing partial carried over — under
 * deliberately hostile chunk boundaries (1-byte reads, splits inside JSON
 * tokens). The reassembled lines must parse, tolerate keepalive comments, and
 * assemble into the final spec via the same patch semantics the disconnect-
 * persist path uses server-side.
 */
import { describe, it, expect } from "vitest";
import { patchStreamResponse } from "@/lib/pipeline/patch-stream";
import { assembleSpecFromPatches } from "@/lib/pipeline/assemble-spec";
import type { PatchLike } from "@/lib/pipeline/computed-key-audit";

/** A realistic Ask-run emission: progress → warehouse id → elements → cost. */
function emitRealisticRun(stream: {
  emit: (s: string) => void;
  emitProgress: (stage: string, step: number, total: number) => void;
}) {
  stream.emitProgress("generating_sql", 1, 5);
  stream.emit(
    JSON.stringify({ op: "add", path: "/state/__warehouse_csv_id", value: "csv-9" }) + "\n"
  );
  stream.emitProgress("computing", 2, 5); // must NOT clobber __warehouse_csv_id
  stream.emit(JSON.stringify({ op: "add", path: "/root", value: "dash" }) + "\n");
  stream.emit(
    JSON.stringify({
      op: "add",
      path: "/elements/dash",
      value: { type: "Column", props: {}, children: ["kpi"] },
    }) + "\n"
  );
  stream.emit(": keepalive\n"); // comment line mid-stream
  stream.emit(
    JSON.stringify({
      op: "add",
      path: "/elements/kpi",
      value: { type: "StatCard", props: { label: "Total", value: 42 }, children: [] },
    }) + "\n"
  );
  stream.emit(JSON.stringify({ op: "add", path: "/state/__cost", value: { costUsd: 0.1 } }) + "\n");
}

/** Consume a Response body in chunks of `size` bytes, client-style. */
async function consumeInChunks(res: Response, size: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const pending = new Uint8Array(0);
  const raw: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw.push(value);
  }
  // Re-chunk the full byte stream at hostile boundaries of `size`.
  const all = new Uint8Array(raw.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of raw) {
    all.set(c, off);
    off += c.length;
  }
  const lines: string[] = [];
  let buffer = "";
  for (let i = 0; i < all.length; i += size) {
    const chunk = all.slice(i, i + size);
    void pending;
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts);
  }
  if (buffer.trim()) lines.push(buffer);
  return lines;
}

function toPatches(lines: string[]): PatchLike[] {
  const patches: PatchLike[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith(":")) continue; // keepalive comment — must be skippable
    patches.push(JSON.parse(t)); // every non-comment line MUST be valid JSON
  }
  return patches;
}

describe("NDJSON patch-stream protocol", () => {
  for (const chunkSize of [1, 7, 64 * 1024]) {
    it(`survives ${chunkSize}-byte chunk boundaries and assembles the full spec`, async () => {
      const res = patchStreamResponse("/api/test", new Request("http://x"), async (stream) => {
        emitRealisticRun(stream);
      });
      const lines = await consumeInChunks(res, chunkSize);
      const patches = toPatches(lines); // throws on any malformed line

      const spec = assembleSpecFromPatches(patches);
      expect(spec).not.toBeNull();
      expect(spec!.root).toBe("dash");
      expect(spec!.elements.dash).toBeDefined();
      expect(spec!.elements.kpi).toMatchObject({ type: "StatCard" });
    });
  }

  it("preserves event ordering: progress first, __cost last", async () => {
    const res = patchStreamResponse("/api/test", new Request("http://x"), async (stream) => {
      emitRealisticRun(stream);
    });
    const patches = toPatches(await consumeInChunks(res, 13));
    expect(patches[0].path).toBe("/state"); // wholesale add carrying __progress
    expect(patches[patches.length - 1].path).toBe("/state/__cost");
  });

  it("progress replaces never clobber sibling state (the __warehouse_csv_id regression)", async () => {
    const res = patchStreamResponse("/api/test", new Request("http://x"), async (stream) => {
      emitRealisticRun(stream);
    });
    const patches = toPatches(await consumeInChunks(res, 5));
    const spec = assembleSpecFromPatches(patches)!;
    const state = spec.state as Record<string, unknown>;
    expect(state.__warehouse_csv_id).toBe("csv-9");
    expect((state.__progress as { stage: string }).stage).toBe("computing");
  });
});

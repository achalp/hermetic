import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/wasm-result/route";
import { getHandoffRegistry } from "@/lib/sandbox/wasm/handoff-singleton";

/**
 * POST /api/wasm-result — the browser worker returns its result here, resolving
 * the pending handoff the run pipeline is awaiting (build log D6). 400 without an
 * id / on a non-object body, 404 for an unknown-or-settled id, and a resolve that
 * completes the awaiting promise on success. The envelope is UNTRUSTED here; the
 * relay re-validates it downstream (a NaN exitCode is passed through, not zeroed).
 */
const post = (url: string, body: unknown) =>
  POST(new NextRequest(new Request(url, { method: "POST", body: JSON.stringify(body) })));

describe("POST /api/wasm-result", () => {
  it("400s without an id", async () => {
    const res = await post("http://x/api/wasm-result", { exitCode: 0, output: {} });
    expect(res.status).toBe(400);
  });

  it("400s on a non-object body", async () => {
    const res = await post("http://x/api/wasm-result?id=whatever", 42);
    expect(res.status).toBe(400);
  });

  it("404s for an unknown or already-settled id", async () => {
    const res = await post("http://x/api/wasm-result?id=nope-not-pending", {
      exitCode: 0,
      output: {},
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ resolved: false });
  });

  it("resolves the pending handoff and completes its promise", async () => {
    const { id, promise } = getHandoffRegistry().create();
    const res = await post(`http://x/api/wasm-result?id=${id}`, {
      exitCode: 0,
      output: { results: { n: 1 } },
      stderr: "warn",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: true });
    await expect(promise).resolves.toEqual({
      exitCode: 0,
      output: { results: { n: 1 } },
      stderr: "warn",
    });
    // second POST for the same (now settled) id is a no-op 404
    const again = await post(`http://x/api/wasm-result?id=${id}`, { exitCode: 0, output: {} });
    expect(again.status).toBe(404);
  });

  it("passes a non-numeric exitCode through as NaN (never trusted as 0)", async () => {
    const { id, promise } = getHandoffRegistry().create();
    await post(`http://x/api/wasm-result?id=${id}`, { exitCode: "0", output: {} });
    const env = await promise;
    expect(Number.isNaN(env.exitCode)).toBe(true);
  });
});

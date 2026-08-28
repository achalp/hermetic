import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET } from "@/app/api/wasm-input/[token]/route";
import { getInputRegistry } from "@/lib/sandbox/wasm/input-singleton";

/**
 * GET /api/wasm-input/<token> — token-scoped delivery of a host file to the worker
 * (build log D11). The worker holds only the token (a capability), never a path.
 */
let dir: string;
const req = () => new NextRequest("http://x/api/wasm-input/t");
const params = (token: string) => ({ params: Promise.resolve({ token }) });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wasm-input-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("GET /api/wasm-input/[token]", () => {
  it("streams the registered file's bytes for a valid token", async () => {
    const file = join(dir, "input.parquet");
    writeFileSync(file, "PARQUET-BYTES-123");
    const token = getInputRegistry().register({ hostPath: file, runId: "r1" });

    const res = await GET(req(), params(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("PARQUET-BYTES-123");
  });

  it("404s an unknown token (no path ever accepted from the caller)", async () => {
    const res = await GET(req(), params("not-a-real-token"));
    expect(res.status).toBe(404);
  });

  it("404s a token whose file was released/removed", async () => {
    const token = getInputRegistry().register({ hostPath: join(dir, "vanished") });
    const res = await GET(req(), params(token));
    expect(res.status).toBe(404);
  });
});

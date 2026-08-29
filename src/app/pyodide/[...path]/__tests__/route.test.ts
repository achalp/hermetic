import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GET } from "@/app/pyodide/[...path]/route";

/**
 * GET /pyodide/* — serves the bundled Pyodide dist to the WASM worker (build log
 * D15). The path-traversal guard is load-bearing (segments come from the URL).
 */
let dir: string;
const req = () => new NextRequest("http://x/pyodide/x");
const params = (path: string[]) => ({ params: Promise.resolve({ path }) });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pyodide-route-"));
  writeFileSync(join(dir, "pyodide.js"), "globalThis.loadPyodide = 1;");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "x.wasm"), "\0asm");
  writeFileSync(join(dir, "secret-outside"), "SECRET"); // sibling of the served file
  process.env.HERMETIC_PYODIDE_DIR = dir;
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HERMETIC_PYODIDE_DIR;
});

describe("GET /pyodide/[...path]", () => {
  it("serves a dist file with the right content-type", async () => {
    const res = await GET(req(), params(["pyodide.js"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("loadPyodide");
  });

  it("serves nested files and sets wasm content-type", async () => {
    const res = await GET(req(), params(["sub", "x.wasm"]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/wasm");
  });

  it("404s an unknown file", async () => {
    expect((await GET(req(), params(["nope.js"]))).status).toBe(404);
  });

  it("BLOCKS path traversal outside the dist root (403 or 404, never the secret)", async () => {
    const res = await GET(req(), params(["..", "secret-outside"]));
    expect([403, 404]).toContain(res.status);
    if (res.status === 200) throw new Error("traversal escaped the pyodide root!");
  });
});

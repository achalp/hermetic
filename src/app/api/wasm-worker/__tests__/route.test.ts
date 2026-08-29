import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/wasm-worker/route";
import { WASM_EXEC_CSP, WASM_PRELUDE } from "@/lib/sandbox/wasm/runtime-constants";

/**
 * GET /api/wasm-worker — serves the execution worker under the LOCKED exec CSP.
 * The worker inherits this CSP from its own script response (spec §7), so these
 * header invariants ARE the security boundary; regressing them is a real hole.
 */
describe("GET /api/wasm-worker", () => {
  it("serves the worker under the shared WASM_EXEC_CSP (D8=self)", () => {
    const res = GET();
    expect(res.headers.get("content-security-policy")).toBe(WASM_EXEC_CSP);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("restricts the worker to same-origin only (Tauri-local model, D8=self)", () => {
    const csp = GET().headers.get("content-security-policy")!;
    // default-src 'none' + connect-src 'self' = no cross-origin host reachable;
    // in Tauri 'self' is the local app protocol, so there is no internet egress.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    // No wildcard / external hosts may ever appear — that WOULD open egress.
    expect(csp).not.toContain("*");
    expect(csp).not.toMatch(/https?:/);
    // 'self' scopes script-src to the bundled dist; blob: + wasm-unsafe-eval only.
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' blob:");
  });

  it("embeds the SHARED prelude (cannot drift from the Node parity executor)", async () => {
    const body = await GET().text();
    // The prelude's json allow_nan shim is the load-bearing parity line.
    expect(WASM_PRELUDE).toContain("allow_nan");
    expect(body).toContain("allow_nan");
    // The worker returns a raw envelope, not a decoded ExecutionResult.
    expect(body).toContain("output.json");
    expect(body).toContain("stderr.txt");
  });
});

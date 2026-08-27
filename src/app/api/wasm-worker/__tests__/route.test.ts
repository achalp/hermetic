import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/wasm-worker/route";
import { WASM_EXEC_CSP, WASM_PRELUDE } from "@/lib/sandbox/wasm/runtime-constants";

/**
 * GET /api/wasm-worker — serves the execution worker under the LOCKED exec CSP.
 * The worker inherits this CSP from its own script response (spec §7), so these
 * header invariants ARE the security boundary; regressing them is a real hole.
 */
describe("GET /api/wasm-worker", () => {
  it("serves the worker under the exact escape-suite exec CSP", () => {
    const res = GET();
    expect(res.headers.get("content-security-policy")).toBe(WASM_EXEC_CSP);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("CSP omits 'self' from script-src and blocks all egress (connect-src 'none')", () => {
    const csp = GET().headers.get("content-security-policy")!;
    // A same-origin script URL is an exfil channel — must NOT be allowed.
    expect(csp).not.toContain("'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src blob: 'wasm-unsafe-eval'");
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

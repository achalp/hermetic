import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware, __resetRateLimitForTests } from "@/middleware";

/**
 * M3: the credential-writing /api/settings route must sit behind the same
 * DNS-rebinding origin guard as the other local-path routes, and the guard must
 * match validateLocalOrigin's Host-fallback (absent Origin → require a loopback
 * Host) so an Origin-less rebinding request can't slip through.
 */
const req = (path: string, headers: Record<string, string>) =>
  new NextRequest(new URL(`http://localhost${path}`), { headers });

describe("middleware DNS-rebinding guard", () => {
  beforeEach(() => __resetRateLimitForTests());

  it("blocks /api/settings from a foreign Origin (403)", () => {
    const res = middleware(req("/api/settings", { origin: "http://evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it("allows /api/settings from a loopback Origin", () => {
    const res = middleware(req("/api/settings", { origin: "http://localhost:3000" }));
    expect(res.status).not.toBe(403);
  });

  it("blocks an Origin-less request whose Host is foreign (rebinding via Host)", () => {
    const res = middleware(req("/api/settings", { host: "evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it("allows an Origin-less request with a loopback Host (curl / same-origin)", () => {
    const res = middleware(req("/api/settings", { host: "127.0.0.1:3000" }));
    expect(res.status).not.toBe(403);
  });

  // Default-deny (inverted from the old prefix allowlist): EVERY /api/ route is
  // guarded, including ones no allowlist named. These previously leaked LAN-side.
  it("blocks a previously-unlisted /api route from a foreign Origin (default-deny)", () => {
    const res = middleware(req("/api/plan", { origin: "http://evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it.each(["/api/history", "/api/artifacts/x", "/api/cost", "/api/diagnostics", "/api/vizs"])(
    "blocks %s (formerly unguarded, LAN-readable) from a foreign Origin",
    (path) => {
      expect(middleware(req(path, { origin: "http://evil.example.com" })).status).toBe(403);
    }
  );

  it("still allows a data route from the UI's loopback Origin", () => {
    expect(middleware(req("/api/history", { origin: "http://localhost:3000" })).status).not.toBe(
      403
    );
  });

  it("does NOT guard non-/api page routes (UI only, no data)", () => {
    expect(middleware(req("/results", { origin: "http://evil.example.com" })).status).not.toBe(403);
  });

  // finding H3: the local model-process routes spawn downloads / start servers /
  // rmSync model files — they must sit behind the origin guard so a visited page
  // cannot drive them cross-origin.
  it("blocks /api/local-llm/download from a foreign Origin (403)", () => {
    const res = middleware(req("/api/local-llm/download", { origin: "http://evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it("blocks /api/local-llm/delete from an Origin-less foreign Host (403)", () => {
    const res = middleware(req("/api/local-llm/delete", { host: "evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it("blocks /api/ollama/pull from a foreign Origin (403)", () => {
    const res = middleware(req("/api/ollama/pull", { origin: "http://evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it("still allows the UI's own local-llm polling (loopback Origin)", () => {
    const res = middleware(req("/api/local-llm/status", { origin: "http://localhost:3000" }));
    expect(res.status).not.toBe(403);
  });

  // finding Sec-3 LOW: /api/providers writes API keys to the keychain — guard it
  // like /api/settings for defense-in-depth.
  it("blocks /api/providers from a foreign Origin (403)", () => {
    const res = middleware(req("/api/providers", { origin: "http://evil.example.com" }));
    expect(res.status).toBe(403);
  });

  it("allows /api/providers from a loopback Origin", () => {
    const res = middleware(req("/api/providers", { origin: "http://localhost:3000" }));
    expect(res.status).not.toBe(403);
  });

  it("rate-limits on a constant key — rotating X-Forwarded-For cannot evade (F8)", () => {
    __resetRateLimitForTests();
    const fire = (i: number) =>
      middleware(
        req("/api/query", { origin: "http://localhost:3000", "x-forwarded-for": `10.0.0.${i}` })
      );
    let last: ReturnType<typeof middleware> | undefined;
    for (let i = 0; i <= 60; i++) last = fire(i); // 61 requests, each a different XFF
    // A per-XFF key would give each a fresh bucket (all pass); the constant key
    // shares one, so the 61st trips the 60/min cap.
    expect(last!.status).toBe(429);
  });

  it("exempts the wasm range endpoint — capability-metered, not rate-metered (D36)", () => {
    // DuckDB in the worker reads parquet by SYNCHRONOUS XHR: one scan is
    // legitimately hundreds of small range GETs. Live, the shared bucket 429'd
    // mid-scan — crashing the read AND starving unrelated calls. The route's own
    // unguessable token + per-token BYTE budget bound a runaway client far more
    // meaningfully than a request counter.
    __resetRateLimitForTests();
    let last: ReturnType<typeof middleware> | undefined;
    for (let i = 0; i <= 200; i++)
      last = middleware(
        req("/api/wasm-range/6f000000-0000-4000-8000-000000000001", {
          origin: "http://localhost:3000",
        })
      );
    expect(last!.status).not.toBe(429);
  });

  it("the exemption does NOT bypass the local-origin gate", () => {
    // Only the RATE cap is exempted; a cross-origin request still 403s.
    const res = middleware(
      req("/api/wasm-range/6f000000-0000-4000-8000-000000000001", {
        origin: "https://evil.example.com",
      })
    );
    expect(res.status).toBe(403);
  });

  it("a range-read burst does not starve OTHER api routes' budget", () => {
    // The flood must not land in the shared bucket at all — after 200 range
    // reads, an ordinary API call still has its full budget.
    __resetRateLimitForTests();
    for (let i = 0; i <= 200; i++)
      middleware(
        req("/api/wasm-range/6f000000-0000-4000-8000-000000000001", {
          origin: "http://localhost:3000",
        })
      );
    const res = middleware(req("/api/query", { origin: "http://localhost:3000" }));
    expect(res.status).not.toBe(429);
  });
});

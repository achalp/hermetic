import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

/**
 * M3: the credential-writing /api/settings route must sit behind the same
 * DNS-rebinding origin guard as the other local-path routes, and the guard must
 * match validateLocalOrigin's Host-fallback (absent Origin → require a loopback
 * Host) so an Origin-less rebinding request can't slip through.
 */
const req = (path: string, headers: Record<string, string>) =>
  new NextRequest(new URL(`http://localhost${path}`), { headers });

describe("middleware DNS-rebinding guard", () => {
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

  it("does not guard an unlisted route from a foreign Origin", () => {
    const res = middleware(req("/api/plan", { origin: "http://evil.example.com" }));
    expect(res.status).not.toBe(403);
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
});

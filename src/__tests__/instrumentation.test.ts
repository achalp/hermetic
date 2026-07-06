import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import https from "node:https";
import { register } from "@/instrumentation";

const BIG = 25 * 60 * 1000;

describe("instrumentation register() — HTTP requestTimeout", () => {
  const origHttp = http.createServer;
  const origHttps = https.createServer;
  const origRuntime = process.env.NEXT_RUNTIME;
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
  const origGetHandles = proc._getActiveHandles;

  afterEach(() => {
    http.createServer = origHttp;
    https.createServer = origHttps;
    proc._getActiveHandles = origGetHandles;
    if (origRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = origRuntime;
  });

  it("raises requestTimeout on a server already listening (via active handles)", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const listening = { requestTimeout: 300_000 };
    proc._getActiveHandles = () => [listening, { notAServer: true }, null];
    await register();
    expect(listening.requestTimeout).toBe(BIG);
  });

  it("patches createServer so servers made afterwards get the raised timeout", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    proc._getActiveHandles = () => [];
    await register();
    const s = http.createServer(() => {});
    expect(s.requestTimeout).toBe(BIG);
    s.close();
  });

  it("only ever raises — leaves an already-larger or 0 (unbounded) timeout alone", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const unbounded = { requestTimeout: 0 };
    const larger = { requestTimeout: BIG + 60_000 };
    proc._getActiveHandles = () => [unbounded, larger];
    await register();
    expect(unbounded.requestTimeout).toBe(0);
    expect(larger.requestTimeout).toBe(BIG + 60_000);
  });

  it("no-ops outside the Node.js runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const listening = { requestTimeout: 300_000 };
    proc._getActiveHandles = () => [listening];
    await register();
    expect(listening.requestTimeout).toBe(300_000);
  });
});

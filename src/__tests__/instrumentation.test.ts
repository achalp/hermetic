import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import https from "node:https";
import { raiseServerTimeouts } from "@/instrumentation-node";

const BIG = 25 * 60 * 1000;

describe("raiseServerTimeouts — HTTP requestTimeout", () => {
  const origHttp = http.createServer;
  const origHttps = https.createServer;
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
  const origGetHandles = proc._getActiveHandles;

  afterEach(() => {
    http.createServer = origHttp;
    https.createServer = origHttps;
    proc._getActiveHandles = origGetHandles;
  });

  it("raises requestTimeout on a server already listening (via active handles)", async () => {
    const listening = { requestTimeout: 300_000 };
    proc._getActiveHandles = () => [listening, { notAServer: true }, null];
    await raiseServerTimeouts();
    expect(listening.requestTimeout).toBe(BIG);
  });

  it("patches createServer so servers made afterwards get the raised timeout", async () => {
    proc._getActiveHandles = () => [];
    await raiseServerTimeouts();
    const s = http.createServer(() => {});
    expect(s.requestTimeout).toBe(BIG);
    s.close();
  });

  it("only ever raises — leaves an already-larger or 0 (unbounded) timeout alone", async () => {
    const unbounded = { requestTimeout: 0 };
    const larger = { requestTimeout: BIG + 60_000 };
    proc._getActiveHandles = () => [unbounded, larger];
    await raiseServerTimeouts();
    expect(unbounded.requestTimeout).toBe(0);
    expect(larger.requestTimeout).toBe(BIG + 60_000);
  });
});

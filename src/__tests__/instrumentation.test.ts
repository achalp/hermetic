import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import https from "node:https";
import { raiseServerTimeouts, isAbortedConnectionError } from "@/instrumentation-node";

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

describe("isAbortedConnectionError — benign client-disconnect classifier", () => {
  it("matches the aborted-socket signatures (client left mid-stream)", () => {
    expect(isAbortedConnectionError({ code: "ECONNRESET" })).toBe(true);
    expect(isAbortedConnectionError({ code: "ECONNABORTED" })).toBe(true);
    expect(isAbortedConnectionError({ code: "ERR_STREAM_PREMATURE_CLOSE" })).toBe(true);
    expect(isAbortedConnectionError(Object.assign(new Error("aborted"), {}))).toBe(true);
    expect(isAbortedConnectionError(new Error("The operation was aborted"))).toBe(true);
  });

  it("does NOT match genuine errors (never mask a real bug)", () => {
    expect(isAbortedConnectionError(new TypeError("x is not a function"))).toBe(false);
    expect(isAbortedConnectionError({ code: "ENOENT" })).toBe(false);
    expect(isAbortedConnectionError(new Error("out of memory"))).toBe(false);
    expect(isAbortedConnectionError(null)).toBe(false);
    expect(isAbortedConnectionError(undefined)).toBe(false);
  });
});

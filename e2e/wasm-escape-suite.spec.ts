/**
 * Phase 0(b) — the ship-gating ESCAPE SUITE (spec §7), run in real chromium.
 *
 * The load-bearing security claim: with the execution-context CSP `connect-src
 * 'none'`, code running in a dedicated Web Worker CANNOT exfiltrate — regardless
 * of any captured JS reference (which is why the CSP, not the delete-based FFI
 * scrub, is the boundary; the scrub is defense-in-depth). Pyodide's `import js`
 * FFI reaches the same worker-global `fetch`/`WebSocket`/… as plain JS, so
 * proving the CSP blocks those from the worker proves it blocks the FFI path too.
 *
 * This test serves a page + a CSP-locked worker over real HTTP, has the worker
 * attempt every egress vector at a server endpoint, and asserts BOTH:
 *   (a) every vector threw / failed inside the worker (self-report), AND
 *   (b) the server received ZERO exfil requests (ground truth) — nothing left.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The execution-context CSP (spec §7 #2, CORRECTED by this suite's first run):
// script-src must NOT include 'self' — that permits same-origin importScripts /
// import() URLs, a real exfil channel (data in the URL; the request leaves even
// if the script never executes). Pyodide loads from pre-fetched blob: URLs, so
// `script-src blob: 'wasm-unsafe-eval'` runs Pyodide + WASM while blocking
// same-origin script-URL egress. 'wasm-unsafe-eval' permits WebAssembly.compile
// only, not eval/scripts.
const EXEC_CSP =
  "default-src 'none'; script-src blob: 'wasm-unsafe-eval'; " +
  "connect-src 'none'; img-src 'none'; worker-src 'none'; child-src 'none'";

// The worker: attempt egress every way, report {vector, blocked}. `blocked` means
// the attempt threw synchronously or rejected/errored — i.e. did NOT reach out.
const WORKER_JS = `
// A reference captured BEFORE any scrub — proves the CSP blocks even a saved ref
// (so CSP, not reference-deletion, is what holds).
const capturedFetch = self.fetch.bind(self);
const EXFIL = self.location.origin + "/exfil";
const EXFIL_WS = EXFIL.replace("http", "ws") + "-ws";

async function tryVector(name, fn) {
  try {
    await fn();
    return { vector: name, blocked: false }; // reached out — BAD
  } catch {
    return { vector: name, blocked: true };  // threw / blocked — GOOD
  }
}

async function run() {
  const results = [];
  results.push(await tryVector("fetch", () => self.fetch(EXFIL + "?v=fetch")));
  results.push(await tryVector("captured-fetch", () => capturedFetch(EXFIL + "?v=capref")));
  results.push(await tryVector("xhr", () => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.onload = () => res(); x.onerror = () => rej(new Error("blocked"));
    try { x.open("GET", EXFIL + "?v=xhr"); x.send(); } catch (e) { rej(e); }
  })));
  results.push(await tryVector("websocket", () => new Promise((res, rej) => {
    let ws;
    try { ws = new WebSocket(EXFIL_WS); } catch (e) { return rej(e); }
    ws.onopen = () => res(); ws.onerror = () => rej(new Error("blocked"));
    setTimeout(() => rej(new Error("timeout")), 1500);
  })));
  results.push(await tryVector("sendBeacon", () => {
    const ok = navigator.sendBeacon(EXFIL + "?v=beacon", "secret");
    if (ok) return Promise.resolve(); // queued to send — treat as NOT blocked
    throw new Error("beacon refused");
  }));
  results.push(await tryVector("eventsource", () => new Promise((res, rej) => {
    let es;
    try { es = new EventSource(EXFIL + "?v=es"); } catch (e) { return rej(e); }
    es.onopen = () => res(); es.onerror = () => rej(new Error("blocked"));
    setTimeout(() => rej(new Error("timeout")), 1500);
  })));
  results.push(await tryVector("importScripts", () => {
    importScripts(EXFIL + "?v=importscripts"); // sync; throws on CSP block
    return Promise.resolve();
  }));
  results.push(await tryVector("dynamic-import", () => import(EXFIL + "?v=dynimport")));
  self.postMessage({ done: true, results });
}
run();
`;

let server: Server;
let base: string;
let exfilHits: string[] = [];

test.beforeAll(async () => {
  exfilHits = [];
  server = createServer((req, res) => {
    const url = req.url || "/";
    if (url.startsWith("/exfil")) {
      // GROUND TRUTH: any request here means egress escaped the CSP.
      exfilHits.push(url);
      res.writeHead(200, { "access-control-allow-origin": "*" });
      res.end("hit");
      return;
    }
    if (url === "/exec-worker.js") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        // The exec-context CSP is delivered on the WORKER SCRIPT response, so it
        // governs the worker context (this is how worker CSP is set).
        "content-security-policy": EXEC_CSP,
      });
      res.end(WORKER_JS);
      return;
    }
    // The host page: spawn the locked worker, relay its report to window.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><title>escape</title><script>
      window.__result = null;
      const w = new Worker("/exec-worker.js");
      w.onmessage = (e) => { window.__result = e.data; };
      w.onerror = (e) => { window.__result = { error: String(e.message || e) }; };
    </script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("exec-worker under connect-src 'none' cannot exfiltrate by ANY vector", async ({ page }) => {
  await page.goto(base);
  await page.waitForFunction(() => (window as unknown as { __result: unknown }).__result !== null, {
    timeout: 15_000,
  });
  const result = await page.evaluate(
    () =>
      (
        window as unknown as {
          __result: {
            done?: boolean;
            results?: { vector: string; blocked: boolean }[];
            error?: string;
          };
        }
      ).__result
  );

  expect(result.error, `worker errored: ${result.error}`).toBeFalsy();
  expect(result.done).toBe(true);
  const results = result.results!;

  // (a) self-report: EVERY egress vector blocked.
  const leaked = results.filter((r) => !r.blocked).map((r) => r.vector);
  expect(leaked, `these vectors were NOT blocked: ${leaked.join(", ")}`).toEqual([]);

  // Every named vector actually ran.
  const vectors = results.map((r) => r.vector).sort();
  expect(vectors).toContain("fetch");
  expect(vectors).toContain("captured-fetch"); // the load-bearing one
  expect(vectors).toContain("websocket");

  // (b) GROUND TRUTH: the server saw zero exfil requests. Nothing left the worker.
  expect(exfilHits, `server received exfil hits: ${exfilHits.join(", ")}`).toEqual([]);
});

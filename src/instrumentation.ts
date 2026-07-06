/**
 * Next.js instrumentation — runs `register()` once, INSIDE the server process
 * that actually binds the port and holds client sockets (the `next-server`
 * worker). That process is spawned with NODE_OPTIONS stripped, so the
 * `--import ./scripts/server-timeouts.mjs` preload never reaches it and its HTTP
 * `requestTimeout` stays at Node's 5-minute default — which drops the browser
 * connection mid-request on long remote/large-data analyses ("network error"),
 * even though the handler keeps running.
 *
 * We raise it here from within that process: patch `createServer` for any server
 * created after this runs, AND lift the timeout on the server that is already
 * listening (Next creates it before app init, so it's in the active handles).
 */
const REQUEST_TIMEOUT_MS = 25 * 60 * 1000; // 25 min — matches the large-data budget

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const http = await import("node:http");
  const https = await import("node:https");

  const raise = (s: { requestTimeout?: number } | null | undefined): void => {
    if (!s || typeof s.requestTimeout !== "number") return;
    // 0 means "no timeout" (already unbounded); otherwise only ever raise it.
    if (s.requestTimeout !== 0 && s.requestTimeout < REQUEST_TIMEOUT_MS) {
      s.requestTimeout = REQUEST_TIMEOUT_MS;
    }
  };

  // (a) Servers created AFTER register() runs.
  for (const mod of [http.default, https.default]) {
    const orig = mod.createServer.bind(mod);
    (mod as { createServer: (...a: unknown[]) => import("node:http").Server }).createServer = (
      ...args: unknown[]
    ) => {
      const server = (orig as (...a: unknown[]) => import("node:http").Server)(...args);
      raise(server);
      return server;
    };
  }

  // (b) The server already listening (Next binds the port before app init).
  const handles =
    (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? [];
  for (const h of handles) raise(h as { requestTimeout?: number });
}

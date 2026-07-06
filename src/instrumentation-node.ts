/**
 * Node-runtime-only half of the instrumentation. Kept in a separate module that
 * `instrumentation.ts` dynamically imports ONLY when NEXT_RUNTIME === "nodejs",
 * so the Edge bundle never pulls in node:http/node:https (which it can't run).
 *
 * Raises the HTTP `requestTimeout` on the server process that binds the port and
 * holds client sockets. That `next-server` worker is spawned with NODE_OPTIONS
 * stripped, so the `--import` preload never reaches it and its timeout stays at
 * Node's 5-min default — dropping the browser mid-request on long analyses.
 */
const REQUEST_TIMEOUT_MS = 25 * 60 * 1000; // 25 min — matches the large-data budget

export async function raiseServerTimeouts(): Promise<void> {
  const http = await import("node:http");
  const https = await import("node:https");

  const raise = (s: { requestTimeout?: number } | null | undefined): void => {
    if (!s || typeof s.requestTimeout !== "number") return;
    // 0 means "no timeout" (already unbounded); otherwise only ever raise it.
    if (s.requestTimeout !== 0 && s.requestTimeout < REQUEST_TIMEOUT_MS) {
      s.requestTimeout = REQUEST_TIMEOUT_MS;
    }
  };

  // (a) Servers created AFTER this runs.
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

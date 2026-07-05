/**
 * Node preload (via NODE_OPTIONS=--import) that raises the HTTP server timeouts
 * Next.js leaves at their Node defaults.
 *
 * Next's start-server only sets `keepAliveTimeout`; `requestTimeout` stays at
 * Node's 300000ms (5 min) default. That is a HARD cap — not reset by response
 * activity — so a legitimately long request (a billion-row Overture scan over
 * S3 can run many minutes) has its socket destroyed at 5 min and the browser
 * sees a "network error", even though the server keeps running to completion.
 *
 * We patch http/https `createServer` so every server Next creates (the dev
 * router-server proxy and the app server alike) gets a generous budget that
 * matches the large-data sandbox timeout. Runs before Next creates any server
 * because `--import` preloads execute first.
 */
import http from "node:http";
import https from "node:https";

// A hair above the 21-min large-data request budget (LARGE_DATA_TIMEOUT_MS + the
// container/route buffer) so the socket outlives the slowest legitimate query.
const REQUEST_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

function patch(mod) {
  const original = mod.createServer.bind(mod);
  mod.createServer = (...args) => {
    const server = original(...args);
    // Only raise; never lower a timeout Next may have set intentionally.
    if (server.requestTimeout === 0 || server.requestTimeout > REQUEST_TIMEOUT_MS) {
      // 0 means "no timeout" — already unbounded, leave it.
    } else {
      server.requestTimeout = REQUEST_TIMEOUT_MS;
    }
    // headersTimeout must not exceed requestTimeout; keep it modest but safe.
    if (server.headersTimeout && server.headersTimeout < 60_000) {
      server.headersTimeout = 60_000;
    }
    return server;
  };
}

patch(http);
patch(https);

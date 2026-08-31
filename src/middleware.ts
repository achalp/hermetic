import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { BASEMAP_STYLE_URL, BASEMAP_TILE_URLS } from "@/lib/basemap-constants";
import { logger } from "@/lib/logger";

// CSP hosts derived from the SAME constants self-hosters override (leaf
// module: Edge-safe, no envConfig evaluation) — a
// re-pointed basemap must not be silently blocked by a stale literal here.
const BASEMAP_HOSTS = Array.from(
  new Set(
    [BASEMAP_STYLE_URL, BASEMAP_TILE_URLS.dark, BASEMAP_TILE_URLS.light].map(
      (u) => new URL(u).origin
    )
  )
);
const BASEMAP_WILDCARD = BASEMAP_HOSTS.map((o) => o.replace("://", "://*.")).join(" ");

/**
 * Simple in-memory rate limiter for API routes.
 * Resets on server restart — sufficient for a single-instance app.
 */
const rateMap = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT = 60; // requests per window (raised from 30 — UI polling alone can exceed 30)
const RATE_WINDOW_MS = 60_000; // 1 minute
// Bound the map (M5): expired entries were never deleted, so unique IPs grew
// it without limit. Compact opportunistically once it exceeds the cap.
const RATE_MAP_MAX_ENTRIES = 10_000;

/** Test-only: clear the module-global rate map so cases don't bleed together. */
export function __resetRateLimitForTests(): void {
  rateMap.clear();
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  if (rateMap.size > RATE_MAP_MAX_ENTRIES) {
    for (const [k, v] of rateMap) {
      if (now > v.resetAt) rateMap.delete(k);
    }
  }
  const entry = rateMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT;
}

/**
 * Default-deny origin guard. EVERY /api/ route requires a local request (loopback
 * Origin, or absent-Origin with a loopback Host — see isLocalRequest). This is an
 * allowlist inverted to a denylist: the previous LOCAL_PATH_ROUTES prefix list
 * left history/artifacts/cost/diagnostics/vizs/skills/audit reachable from the
 * LAN and left every state-changing POST (suggest, schedule, rerun) CSRF-drivable
 * by any visited page. The app is local-first: the UI always carries a loopback
 * Origin/Host, and no internal caller (CLI/MCP drive lib directly, not HTTP), so
 * guarding all of /api/ costs legitimate callers nothing. Non-/api page routes
 * serve only UI, never data, so they are intentionally not guarded here.
 */

function isLoopback(value: string | null, viaUrl: boolean): boolean {
  if (!value) return false;
  try {
    const hostname = viaUrl ? new URL(value).hostname : new URL(`http://${value}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Loopback check mirroring lib/local-files/security.ts:validateLocalOrigin (the
 * middleware can't import it — that module pulls node-only deps unavailable in
 * the Edge runtime). When an Origin header is present it must be loopback; when
 * it is absent (same-origin GET, curl, CLI) the Host header must be loopback —
 * a DNS-rebinding request necessarily carries the attacker's hostname in Host,
 * so requiring a loopback Host closes that hole the origin-only check left open.
 */
function isLocalRequest(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (origin) return isLoopback(origin, true);
  return isLoopback(request.headers.get("host"), false);
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // DNS-rebinding protection: a browser on a malicious page can be tricked
  // into requesting this localhost server with a foreign Origin. Any route
  // touching host paths or credentials requires a local (or absent-Origin but
  // loopback-Host — CLI, curl, same-origin GET) request.
  if (pathname.startsWith("/api/") && !isLocalRequest(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  if (pathname.startsWith("/api/")) {
    // Exempt internal polling endpoints: the local-llm status/models/platform
    // routes are called by the UI's polling loop every 3 seconds during server
    // startup, easily exceeding any reasonable rate limit. These are
    // localhost-only internal calls that don't need abuse protection.
    const isInternalPolling =
      pathname.startsWith("/api/local-llm/") ||
      pathname.startsWith("/api/providers") ||
      pathname.startsWith("/api/ollama/");

    // The wasm range endpoint is CAPABILITY-metered, not rate-metered (D36):
    // DuckDB in the worker reads parquet by synchronous XHR, so a single scan is
    // legitimately a burst of hundreds of small range GETs — any request-rate cap
    // sized for human traffic breaks it by design (observed live: mid-scan 429s
    // crashed the read AND flooded the shared bucket so unrelated calls 429'd).
    // The route's own guards bound a runaway client more meaningfully than a
    // request counter ever did here: an unguessable UUID token (404 without it)
    // and a per-token BYTE budget charged before bytes are served. The loopback
    // origin gate above still applies — this exempts only the rate cap.
    const isCapabilityMetered = pathname.startsWith("/api/wasm-range/");

    if (!isInternalPolling && !isCapabilityMetered) {
      // All /api traffic is loopback (the default-deny origin guard above 403s
      // anything else), so there is no fronting proxy and X-Forwarded-For is
      // attacker-controlled: keying on it let a local client rotate the header
      // to evade the cap, and collapsed legitimate callers into one shared
      // "unknown" bucket. A single local user needs a single bucket — this
      // guards against a runaway client, not multi-tenant abuse.
      const key = "local";

      if (isRateLimited(key)) {
        // A 429 was previously invisible server-side — a client hitting the
        // limit just saw failing requests with nothing to debug from. The ip
        // is the rate key (identifies the caller, not data — same policy as
        // audit's file paths).
        logger.warn("Rate limit exceeded", { path: pathname });
        return NextResponse.json(
          { error: "Too many requests. Please try again later." },
          { status: 429 }
        );
      }
    }
  }

  const response = NextResponse.next();

  // Security headers
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // CSP (M5): the renderer executes LLM-authored specs and the layout injects
  // an inline no-FOUC script, so the policy is the real defense line.
  // - script-src 'unsafe-inline'/'unsafe-eval': required by the inline
  //   bootstrap and Next dev; charts are data-driven, never script-driven.
  // - img-src data:/blob:: chart exports; connect-src limits egress to
  //   same-origin plus the configured basemap/CDN hosts (constants.ts).
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${BASEMAP_WILDCARD}`,
      "font-src 'self' data:",
      `connect-src 'self' ${BASEMAP_HOSTS.join(" ")} ${BASEMAP_WILDCARD} https://huggingface.co http://localhost:* http://127.0.0.1:*`,
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
    ].join("; ")
  );

  return response;
}

export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

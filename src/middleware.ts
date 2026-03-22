import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Simple in-memory rate limiter for API routes.
 * Resets on server restart — sufficient for a single-instance app.
 */
const rateMap = new Map<string, { count: number; resetAt: number }>();

const RATE_LIMIT = 60; // requests per window (raised from 30 — UI polling alone can exceed 30)
const RATE_WINDOW_MS = 60_000; // 1 minute

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(ip);

  if (!entry || now > entry.resetAt) {
    rateMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Only rate-limit API routes — but exempt internal polling endpoints.
  // The local-llm status/models/platform routes are called by the UI's
  // polling loop every 3 seconds during server startup, easily exceeding
  // any reasonable rate limit. These are localhost-only internal calls
  // that don't need abuse protection.
  if (pathname.startsWith("/api/")) {
    const isInternalPolling =
      pathname.startsWith("/api/local-llm/") ||
      pathname.startsWith("/api/providers") ||
      pathname.startsWith("/api/ollama/");

    if (!isInternalPolling) {
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

      if (isRateLimited(ip)) {
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
  response.headers.set("X-XSS-Protection", "1; mode=block");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  return response;
}

export const config = {
  matcher: [
    // Match all paths except static files and Next.js internals
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

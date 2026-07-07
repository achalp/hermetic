/**
 * Client→server log bridge. The mid-stream-abort diagnostics in the client
 * (e.g. "[ResponsePanel] UNMOUNTED WHILE STREAMING") only existed in the
 * browser console — they never reached the server logs the team actually
 * debugs from, so they were lost unless devtools happened to be open at the
 * moment of failure. Client components forward important diagnostics here
 * (fire-and-forget; see lib/client-log.ts).
 */
import { z } from "zod";
import { logger } from "@/lib/logger";
import { parseBody } from "@/lib/api-schemas";

const ClientLogSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  msg: z.string().min(1).max(2000),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  try {
    const parsed = parseBody(ClientLogSchema, await request.json());
    if (!parsed.ok) return parsed.response;
    const { level, msg, meta } = parsed.data;
    logger[level](`[client] ${msg}`, meta);
    return new Response(null, { status: 204 });
  } catch {
    // A malformed/aborted body must never produce error noise of its own.
    return new Response(null, { status: 204 });
  }
}

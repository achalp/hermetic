/**
 * Standard terminal error response for API route catch handlers (API-6).
 *
 * Before this, ~30 routes each hand-rolled `err instanceof Error ?
 * err.message : "..."` into a JSON body — with three drifting behaviors:
 * most sites never LOGGED the error (the response body was the only record,
 * gone the moment the client dismissed it), none truncated (a driver error
 * embedding a full SQL statement or a stack-bearing message shipped whole),
 * and the shape/status mapping was per-file convention.
 *
 * Deviation from the review's sketch, deliberate: the review suggested a
 * GENERIC client message with the detail only in server logs. Hermetic is a
 * local-first tool — the user operating the UI owns the server, and the
 * error text (their path, their warehouse's SQL error, their model server)
 * is exactly what makes the failure actionable in the panel. Hiding it
 * behind "Internal error" + a log-tailing step would be a UX regression,
 * not a hardening. So the client keeps the real message, but every error
 * now ALSO lands in the server log with full detail (stack, cause), and
 * the client copy is capped at MAX_CLIENT_ERROR_CHARS — the same cap
 * remote-parquet/schema already used.
 */
import { logger, serializeError } from "@/lib/logger";

/** Cap on error text returned to the client — enough to be actionable,
 *  short enough that a stack trace or embedded SQL statement doesn't ship. */
export const MAX_CLIENT_ERROR_CHARS = 300;

/**
 * Log the error with full detail and return the standard `{ error }` JSON
 * body. `route` tags the log line (e.g. "/api/cost"); `fallback` is the
 * client message when the thrown value has no usable message.
 */
export function apiError(route: string, err: unknown, fallback: string, status = 500): Response {
  logger.error(`${route} failed`, serializeError(err));
  const message = err instanceof Error && err.message ? err.message : fallback;
  return Response.json({ error: message.slice(0, MAX_CLIENT_ERROR_CHARS) }, { status });
}

/** Map a lib-layer ValidationFailure to the HTTP error shape (M3-3c). */
export function validationErrorResponse(failure: { status: number; error: string }): Response {
  return new Response(JSON.stringify({ error: failure.error }), {
    status: failure.status,
    headers: { "Content-Type": "application/json" },
  });
}

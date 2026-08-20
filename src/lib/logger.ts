/**
 * Structured logger for server-side code.
 * Outputs JSON in production, readable format in development.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MIN_LEVEL: LogLevel =
  // Pre-boot infra: the logger loads before harness boot, so it reads the
  // environment directly (documented envConfig() exception).
  (process.env.LOG_LEVEL as LogLevel) || (process.env.NODE_ENV === "production" ? "info" : "debug");

const isProd = process.env.NODE_ENV === "production";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

/**
 * Run-id provider, registered by lib/run-context.ts (dependency inversion:
 * the AsyncLocalStorage lives there so this module never imports
 * node:async_hooks and stays safe for any transitive client bundling).
 */
let runIdProvider: (() => string | undefined) | null = null;
export function setRunIdProvider(fn: () => string | undefined): void {
  runIdProvider = fn;
}

/**
 * Meta hygiene: cap unbounded payloads (fullCode / sql values can embed data
 * rows and were logged whole), redact anything under a secret-shaped KEY, and
 * redact high-confidence secret SHAPES embedded in string VALUES under a benign
 * key — a warehouse driver error carrying `password=…`, a connection URL, a
 * presigned link (finding PE-4: key-name redaction alone missed these).
 */
const MAX_META_STRING = 2000;
const SECRET_KEY_RE = /pass(word)?|secret|token|api[_-]?key|credential/i;
/** How deep to walk nested meta objects/arrays when redacting. */
const MAX_META_DEPTH = 4;

/**
 * Redact secret SHAPES inside a string value. Conservative by construction —
 * only patterns that are secrets by definition, so legitimate content isn't
 * mangled: connection-URL passwords, secret-bearing query params, AWS access
 * keys, Bearer tokens, and DuckDB SECRET literals.
 */
function redactSecretsInString(s: string): string {
  return s
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/?#@\s]+:)([^@/?#\s]+)(@)/gi, "$1[redacted]$3")
    .replace(
      /([?&](?:password|passwd|pwd|token|api[_-]?key|secret|access[_-]?key|signature|x-amz-signature|sig)=)([^&\s"'#]+)/gi,
      "$1[redacted]"
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-aws-key]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/\b(KEY_ID|SECRET)(\s+)'[^']*'/gi, "$1$2'[redacted]'");
}

function sanitizeValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") {
    const red = redactSecretsInString(v);
    return red.length > MAX_META_STRING
      ? red.slice(0, MAX_META_STRING) + `… [+${red.length - MAX_META_STRING} chars]`
      : red;
  }
  if (depth < MAX_META_DEPTH && v !== null && typeof v === "object") {
    if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitizeValue(val, depth + 1);
    }
    return out;
  }
  return v;
}

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = SECRET_KEY_RE.test(k) ? "[redacted]" : sanitizeValue(v, 1);
  }
  return out;
}

function formatMessage(
  level: LogLevel,
  message: string,
  rawMeta?: Record<string, unknown>
): string {
  const meta = rawMeta ? sanitizeMeta(rawMeta) : undefined;
  const runId = runIdProvider?.();
  if (isProd) {
    return JSON.stringify({
      level,
      msg: message,
      ts: new Date().toISOString(),
      ...(runId ? { runId } : {}),
      ...meta,
    });
  }
  // Dev format carries a timestamp too: this app is debugged from dev logs
  // of multi-minute pipelines, and without times you can't reconstruct
  // stage latency or gaps. The [runId] chip joins interleaved concurrent runs.
  const ts = new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
  const prefix = `${ts} [${level.toUpperCase()}]${runId ? ` [${runId}]` : ""}`;
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `${prefix} ${message}${metaStr}`;
}

/**
 * Serialize an error for terminal logger.error sites: name + message + the
 * top stack frames + the cause chain. The pervasive
 * `err instanceof Error ? err.message : String(err)` pattern drops both the
 * stack and the cause, so a novel failure deep in the pipeline (e.g. an
 * AI-SDK APICallError wrapping a fetch error) couldn't be localized from the
 * log. Use for unexpected errors; classified/expected errors can stay
 * message-only.
 */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const out: Record<string, unknown> = { error: err.message, errorName: err.name };
  const frames = err.stack
    ?.split("\n")
    .slice(1, 6)
    .map((s) => s.trim());
  if (frames?.length) out.stack = frames;
  if (err.cause !== undefined) {
    out.cause =
      err.cause instanceof Error ? `${err.cause.name}: ${err.cause.message}` : String(err.cause);
  }
  return out;
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("debug")) console.debug(formatMessage("debug", message, meta));
  },
  info(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("info")) console.info(formatMessage("info", message, meta));
  },
  warn(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("warn")) console.warn(formatMessage("warn", message, meta));
  },
  error(message: string, meta?: Record<string, unknown>) {
    if (shouldLog("error")) console.error(formatMessage("error", message, meta));
  },
};

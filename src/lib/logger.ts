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
 * rows and were logged whole) and redact anything under a secret-shaped key.
 * No credential logging exists today — the denylist is the guard rail for
 * whatever meta object gets passed tomorrow.
 */
const MAX_META_STRING = 2000;
const SECRET_KEY_RE = /pass(word)?|secret|token|api[_-]?key|credential/i;

function sanitizeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "[redacted]";
    } else if (typeof v === "string" && v.length > MAX_META_STRING) {
      out[k] = v.slice(0, MAX_META_STRING) + `… [+${v.length - MAX_META_STRING} chars]`;
    } else {
      out[k] = v;
    }
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

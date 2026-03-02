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
  (process.env.LOG_LEVEL as LogLevel) || (process.env.NODE_ENV === "production" ? "info" : "debug");

const isProd = process.env.NODE_ENV === "production";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  if (isProd) {
    return JSON.stringify({
      level,
      msg: message,
      ts: new Date().toISOString(),
      ...meta,
    });
  }
  const prefix = `[${level.toUpperCase()}]`;
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  return `${prefix} ${message}${metaStr}`;
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

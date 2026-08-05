/**
 * Shared display formatters. Framework-free — safe to import from lib,
 * components, and app code alike. Consolidates copies that had drifted
 * across components and lib (truncate, byte sizes, relative time, the
 * number/currency/percent switch, HTML escaping).
 */

/** Truncate a string to `max` characters, ending with an ellipsis. */
export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Format a byte count for display, e.g. "1.5 MB" (0 → "0 B"). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

/**
 * Relative time label from an ISO string or epoch ms.
 * Past: "just now", "5m ago", "3h ago", "yesterday", "4d ago", then a
 * locale date. Future (e.g. a schedule's next run): "in 5 min", "in 3h",
 * "in 4d". Invalid/empty input returns "".
 */
export function relativeTime(when: string | number): string {
  const then = typeof when === "number" ? when : new Date(when).getTime();
  if (!then) return "";
  const diff = then - Date.now();
  if (diff > 0) {
    const mins = Math.round(diff / 60_000);
    const hrs = Math.round(diff / 3_600_000);
    const days = Math.round(diff / 86_400_000);
    if (mins < 60) return `in ${mins} min`;
    if (hrs < 48) return `in ${hrs}h`;
    return `in ${days}d`;
  }
  const s = Math.max(0, -diff / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * Format a numeric value with explicit format and precision control.
 * Unknown/absent format falls back to locale formatting (integers plain,
 * otherwise at most 2 fraction digits).
 */
export function formatWithPrecision(
  num: number,
  format: "currency" | "percent" | "number" | null | undefined,
  precision?: number | null
): string {
  switch (format) {
    case "currency": {
      const p = precision ?? 2;
      return `$${num.toLocaleString(undefined, { minimumFractionDigits: p, maximumFractionDigits: p })}`;
    }
    case "percent": {
      const p = precision ?? 1;
      return `${num.toFixed(p)}%`;
    }
    case "number": {
      const p = precision ?? undefined;
      return num.toLocaleString(undefined, {
        minimumFractionDigits: p,
        maximumFractionDigits: p,
      });
    }
    default: {
      if (Number.isInteger(num)) return num.toLocaleString();
      return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
  }
}

/** Slider tick/value label: "$1,234", "42%", or plain locale number. */
export function formatSliderValue(
  v: number,
  format: "currency" | "percent" | "number" | null | undefined
): string {
  switch (format) {
    case "currency":
      return `$${v.toLocaleString()}`;
    case "percent":
      return `${v}%`;
    default:
      return v.toLocaleString();
  }
}

/** Escape &, <, > and " for safe interpolation into HTML markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

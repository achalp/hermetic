/**
 * Pure helpers for sizing a "scan-safe" time window from table metadata —
 * the math behind connectors' getScanSafeWindow. Kept engine-agnostic and
 * side-effect-free so the fiddly parsing/sizing is unit-testable without a
 * live warehouse.
 */

/** Extract a UTC-midnight epoch (ms) from any date / datetime / timestamp
 *  string (e.g. "2023-10-01", "2023-10-01T12:00:00", "2023-10-01 12:00:00 UTC").
 *  Day-granular is enough to bound a scan. Returns null if no date is found. */
export function extractDateEpoch(s: unknown): number | null {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(s ?? ""));
  return m ? Date.parse(m[1] + "T00:00:00Z") : null;
}

/** Parse a BigQuery time-partition id (YYYY | YYYYMM | YYYYMMDD | YYYYMMDDHH)
 *  to a UTC epoch (ms). Returns null for non-date ids (e.g. integer-range
 *  partitioning), so the caller can fall back. */
export function parsePartitionId(pid: string): number | null {
  const m = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?$/.exec(pid);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00"] = m;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

export interface SizedWindow {
  /** Day-granular YYYY-MM-DD. */
  start: string;
  end: string;
  estimatedRows: number;
}

/**
 * Size a recent window ending at `maxMs` that holds approximately `budgetRows`,
 * assuming uniform density across [minMs, maxMs]. Returns null when the whole
 * table already fits the budget (no window needed) or the inputs are degenerate.
 */
export function sizeScanWindow(
  minMs: number,
  maxMs: number,
  total: number,
  budgetRows: number
): SizedWindow | null {
  if (!(total > 0) || !(maxMs > minMs)) return null;
  if (total <= budgetRows) return null;
  const spanMs = maxMs - minMs;
  const windowMs = Math.min(spanMs, Math.ceil((budgetRows / total) * spanMs));
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    start: fmt(maxMs - windowMs),
    end: fmt(maxMs),
    estimatedRows: Math.round((windowMs / spanMs) * total),
  };
}

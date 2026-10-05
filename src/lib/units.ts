/**
 * Unit vocabulary shared by the prose resolver and the headline planner. No
 * imports: both the LLM layer and the pure findings layer depend on it.
 */

/** Currency units, mirroring the MONETARY allowlist in the sandbox runtime
 *  (docker/sandbox/hermetic_runtime/regimes.py `_CURRENCIES`). Keep the two in
 *  step: the runtime decides zero-sentinel policy from it, this decides display
 *  precision, and a unit in one set but not the other reads inconsistently. */
export const CURRENCY_UNITS = new Set([
  "usd",
  "eur",
  "gbp",
  "jpy",
  "dm",
  "dollar",
  "dollars",
  "$",
  "€",
  "£",
  "¥",
  "cents",
  "cad",
  "aud",
  "chf",
]);

export function isCurrencyUnit(unit: string | undefined): boolean {
  return !!unit && CURRENCY_UNITS.has(unit.trim().toLowerCase());
}

/**
 * Drop a trailing currency segment from a snake_case identifier's words:
 * "total_pipeline_revenue_usd" names the revenue; "usd" is its unit, which
 * the formatted amount already shows. A lone "usd" is kept.
 */
export function stripCurrencySuffix(parts: string[]): string[] {
  return parts.length > 1 && CURRENCY_UNITS.has(parts[parts.length - 1]!.toLowerCase())
    ? parts.slice(0, -1)
    : parts;
}

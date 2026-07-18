"use client";

/**
 * Shared empty-data state for charts. Fifteen charts used to early-return a
 * bare sized <div/> when their data array was empty — an LLM spec pointing at
 * a wrong key produced an unexplained blank region, indistinguishable from a
 * rendering bug, while actual crashes got the labeled "Couldn't render"
 * fallback. This makes "no data" part of the same visible vocabulary.
 */
export function ChartEmptyState({ height }: { height?: number | string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center text-xs text-t-tertiary"
      style={{ height: height ?? 120 }}
    >
      No data for this chart
    </div>
  );
}

"use client";

import { RAIL_COLLAPSED_WIDTH } from "@/app/components/data-rail";
import type { CostInfo } from "@/lib/contracts/stream-state";

/**
 * Thin always-mounted strip at the bottom of the page showing the cost of the
 * last analysis and the running session total, with a link to the full /cost
 * page. Fed by ResponsePanel's onCost (the server emits /state/__cost at the end
 * of each analysis). Hidden until the first analysis completes.
 */

// CostInfo lives in the stream-state contract (M1-1b); re-exported for
// existing importers.
export type { CostInfo };

function fmtUsd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function CostFooter({
  lastCost,
  sessionCostUsd,
}: {
  lastCost: CostInfo | null;
  sessionCostUsd: number;
}) {
  if (!lastCost && sessionCostUsd === 0) return null;

  return (
    <div
      className="fixed bottom-0 flex items-center gap-3 border-l border-t border-border-default bg-surface-1 px-3 py-1 text-xs text-t-tertiary"
      style={{
        // The DataRail is fixed to the right edge at a higher z-index, so a
        // footer flush at right:0 is painted over — the tail of "Cost & usage"
        // disappears under the collapsed icon strip. Sit just clear of it.
        right: RAIL_COLLAPSED_WIDTH,
        zIndex: 120,
        borderTopLeftRadius: "var(--radius-badge)",
      }}
      role="status"
      aria-live="polite"
    >
      {lastCost && (
        <span
          title={`${lastCost.llmCalls} LLM calls · ${lastCost.inputTokens.toLocaleString()} in / ${lastCost.outputTokens.toLocaleString()} out tokens`}
        >
          Last: <span className="font-medium text-t-secondary">{fmtUsd(lastCost.costUsd)}</span>
        </span>
      )}
      <span>
        Session: <span className="font-medium text-t-secondary">{fmtUsd(sessionCostUsd)}</span>
      </span>
      <a href="/cost" className="text-accent hover:underline">
        Cost &amp; usage →
      </a>
    </div>
  );
}

"use client";

import type { QueryMode } from "@/components/app/query-input";

export interface ExampleRun {
  question: string;
  mode: QueryMode;
}

interface ExampleCardsProps {
  /** Attach the sample dataset and run this example. */
  onRun: (run: ExampleRun) => void;
}

/**
 * Starters and payoff preview merged into one section: each card previews a
 * real result shape AND is the one-click way to run that question on the
 * sample dataset. Series colors are the --color-series-* THEME TOKENS (not
 * useChartColors()): the theme attribute is stamped pre-hydration, so CSS
 * vars resolve correctly on first paint while a JS-read palette would SSR
 * with the default theme and hydration-mismatch for any other.
 */
const S1 = "var(--color-series-1)";
const S2 = "var(--color-series-2)";
const S3 = "var(--color-series-3)";

export function ExampleCards({ onRun }: ExampleCardsProps) {
  return (
    <section
      aria-label="Examples — click to run on the sample dataset"
      className="w-full"
      style={{ maxWidth: 920 }}
    >
      <p className="mb-3 text-center text-t-tertiary" style={{ fontSize: 13 }}>
        <strong className="font-semibold text-t-secondary">No data handy?</strong> Click an example
        — it runs live on the sample dataset:
      </p>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}
      >
        <ExampleCard
          question="What did we close this quarter, vs last?"
          heading="“What did we close this quarter?”"
          runLabel="Run →"
          onClick={() =>
            onRun({ question: "What did we close this quarter, vs last?", mode: "ask" })
          }
        >
          <span
            className="block font-bold text-t-primary"
            style={{ fontSize: 28, letterSpacing: -0.5 }}
          >
            $4.82M
          </span>
          <span className="block text-t-tertiary" style={{ fontSize: 12 }}>
            Closed-won revenue · Q2
          </span>
          <span
            className="block font-semibold"
            style={{ fontSize: 12.5, color: "var(--color-trend-up)" }}
          >
            ▲ 12.4% vs Q1
          </span>
        </ExampleCard>

        <ExampleCard
          question="Break down revenue by region."
          heading="“Revenue by region?”"
          runLabel="Run →"
          onClick={() => onRun({ question: "Break down revenue by region.", mode: "ask" })}
        >
          <span
            role="img"
            aria-label="Bar chart preview: West leads four regions at 1.9 million dollars"
            className="flex items-end gap-1.5"
            style={{ height: 64, paddingTop: 4 }}
          >
            {BAR_HEIGHTS.map((h, i) => (
              <span
                key={i}
                className="flex-1"
                style={{
                  height: `${h}%`,
                  minWidth: 10,
                  background: i === 0 ? S1 : S2,
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
              />
            ))}
          </span>
          <span aria-hidden className="mt-1 flex gap-1.5">
            {BAR_LABELS.map((l) => (
              <span
                key={l}
                className="flex-1 text-center text-t-tertiary"
                style={{ fontSize: 10.5 }}
              >
                {l}
              </span>
            ))}
          </span>
        </ExampleCard>

        <ExampleCard
          question="Are win rates trending up? Investigate what's driving the change."
          heading="“Are win rates trending up?”"
          runLabel="Investigate →"
          onClick={() =>
            onRun({
              question: "Are win rates trending up? Investigate what's driving the change.",
              mode: "investigate",
            })
          }
        >
          <svg
            viewBox="0 0 260 68"
            role="img"
            aria-label="Line chart preview: win rate rising from 24 to 31 percent, losses flat"
            className="w-full"
            style={{ height: 68 }}
          >
            <g stroke="var(--color-border-default)" strokeWidth="1">
              <line x1="0" y1="56" x2="260" y2="56" />
              <line x1="0" y1="30" x2="260" y2="30" />
            </g>
            <polyline
              fill="none"
              stroke={S1}
              strokeWidth="2.5"
              strokeLinecap="round"
              points="8,47 56,44 104,39 152,41 200,29 252,19"
            />
            <polyline
              fill="none"
              stroke={S3}
              strokeWidth="2.5"
              strokeLinecap="round"
              points="8,54 56,52 104,53 152,50 200,51 252,49"
            />
            <circle cx="252" cy="19" r="4" fill={S1} />
            <text
              x="248"
              y="10"
              fontSize="10.5"
              fontWeight="600"
              fill="var(--color-t-primary)"
              textAnchor="end"
            >
              31%
            </text>
          </svg>
          <span className="mt-0.5 flex gap-3 text-t-secondary" style={{ fontSize: 11 }}>
            <LegendSwatch color={S1} label="Win rate" />
            <LegendSwatch color={S3} label="Loss rate" />
          </span>
        </ExampleCard>
      </div>
    </section>
  );
}

const BAR_HEIGHTS = [92, 64, 48, 30];
const BAR_LABELS = ["West·$1.9M", "East", "South", "North"];

function ExampleCard({
  heading,
  runLabel,
  onClick,
  children,
  question,
}: {
  heading: string;
  runLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  question: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Run on the sample dataset: ${question}`}
      className="group cursor-pointer border border-border-default bg-surface-1 text-left transition-all hover:-translate-y-0.5 hover:border-accent"
      style={{
        padding: "13px 15px 14px",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card, 0 1px 2px rgb(0 0 0 / 0.05))",
      }}
    >
      <span
        className="mb-2.5 flex items-baseline justify-between gap-2 text-t-secondary"
        style={{ fontSize: 13 }}
      >
        <span className="min-w-0 truncate">{heading}</span>
        <span
          aria-hidden
          className="shrink-0 whitespace-nowrap font-semibold text-accent-text opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          {runLabel}
        </span>
      </span>
      {children}
    </button>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        aria-hidden
        className="inline-block"
        style={{ width: 9, height: 9, borderRadius: 3, background: color }}
      />
      {label}
    </span>
  );
}

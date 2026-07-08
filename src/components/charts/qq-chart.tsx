"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { invNormalCDF, mean, stddev } from "@/lib/chart-stats";
import { ChartEmptyState } from "./chart-empty-state";

interface QQChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  /** Column of raw sample values; theoretical normal quantiles are computed. */
  value_key?: string | null;
  /** Optional precomputed theoretical-quantile column (overrides computation). */
  theoretical_key?: string | null;
  /** Optional precomputed sample-quantile column (pairs with theoretical_key). */
  sample_key?: string | null;
  x_label?: string | null;
  y_label?: string | null;
  color?: string | null;
  height?: number | null;
}

export function QQChartComponent({ props }: { props: QQChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);
  const color = props.color ?? palette[0];

  let theo: number[] = [];
  let samp: number[] = [];

  if (props.theoretical_key && props.sample_key) {
    // Precomputed pairs.
    for (const r of rows) {
      const t = Number(r[props.theoretical_key]);
      const s = Number(r[props.sample_key]);
      if (Number.isFinite(t) && Number.isFinite(s)) {
        theo.push(t);
        samp.push(s);
      }
    }
  } else if (props.value_key) {
    // Raw values: sort, standardize against fitted normal, compute probit positions.
    const vals = rows
      .map((r) => Number(r[props.value_key!]))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const n = vals.length;
    const m = mean(vals);
    const sd = stddev(vals) || 1;
    samp = vals;
    theo = vals.map((_, i) => {
      // Median-rank plotting position (i+0.5)/n.
      const p = (i + 0.5) / n;
      return m + sd * invNormalCDF(p);
    });
  }

  if (samp.length === 0) return <ChartEmptyState height={chart.height} />;

  const lo = Math.min(...theo, ...samp);
  const hi = Math.max(...theo, ...samp);

  const traces: Data[] = [
    {
      type: "scatter" as const,
      mode: "markers" as const,
      x: theo,
      y: samp,
      name: "Quantiles",
      marker: { color, size: 6, opacity: 0.75 },
    },
    {
      type: "scatter" as const,
      mode: "lines" as const,
      x: [lo, hi],
      y: [lo, hi],
      name: "y = x",
      line: { color: "#9ca3af", width: 1, dash: "dash" },
      showlegend: false,
    },
  ];

  const layout: Partial<Layout> = {
    xaxis: { title: { text: props.x_label ?? "Theoretical quantiles" } },
    yaxis: { title: { text: props.y_label ?? "Sample quantiles" } },
    showlegend: false,
  };

  const chartHeight = props.height ?? chart.height;

  return (
    <div className={`w-full${isExpanded ? " h-full flex flex-col" : ""}`}>
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <div className={isExpanded ? "flex-1" : ""}>
        <PlotlyChart data={traces} layout={layout} height={isExpanded ? undefined : chartHeight} />
      </div>
    </div>
  );
}

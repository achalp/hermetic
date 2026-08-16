"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData, resolveColor } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface SeriesSpec {
  key: string;
  label?: string | null;
  type?: "bar" | "line" | null;
  color?: string | null;
}

/** A series entry may arrive as a full spec object or as a bare column name —
 *  the LLM frequently emits the latter (`["churn_mrr"]`) despite the catalog
 *  declaring objects. Normalized by `normalizeSeries` so both plot correctly. */
type SeriesEntry = SeriesSpec | string;

/** Normalize mixed string|object series entries to SeriesSpec, dropping any
 *  without a usable key so a malformed entry can't inject a zero-valued
 *  phantom series (the bug: a bare-string entry read `s.key` → undefined →
 *  every y became `Number(row[undefined]) || 0`). Exported for testing. */
export function normalizeSeries(arr: unknown): SeriesSpec[] {
  return Array.isArray(arr)
    ? arr
        .map((s) => (typeof s === "string" ? { key: s } : (s as SeriesSpec)))
        .filter((s): s is SeriesSpec => !!s && typeof s.key === "string" && s.key.length > 0)
    : [];
}

interface DualAxisChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key: string;
  /** Series plotted against the primary (left) y-axis. */
  left_series: SeriesEntry[];
  /** Series plotted against the secondary (right) y-axis. */
  right_series: SeriesEntry[];
  left_label?: string | null;
  right_label?: string | null;
  left_log?: boolean | null;
  right_log?: boolean | null;
  x_label?: string | null;
  height?: number | null;
}

export function DualAxisChartComponent({ props }: { props: DualAxisChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);
  const left = normalizeSeries(props.left_series);
  const right = normalizeSeries(props.right_series);
  if (rows.length === 0 || (left.length === 0 && right.length === 0))
    return <ChartEmptyState height={chart.height} />;

  const x = rows.map((r) => r[props.x_key] as string | number);
  let colorIdx = 0;
  const buildTrace = (s: SeriesSpec, axis: "y" | "y2"): Data => {
    const color = s.color ? resolveColor(s.color) : palette[colorIdx++ % palette.length];
    const isLine = (s.type ?? (axis === "y2" ? "line" : "bar")) === "line";
    return {
      type: isLine ? ("scatter" as const) : ("bar" as const),
      ...(isLine ? { mode: "lines+markers" as const } : {}),
      x,
      y: rows.map((r) => Number(r[s.key]) || 0),
      name: s.label ?? s.key,
      yaxis: axis,
      marker: { color },
      line: isLine ? { color, width: 2 } : undefined,
    };
  };

  const traces: Data[] = [
    ...left.map((s) => buildTrace(s, "y")),
    ...right.map((s) => buildTrace(s, "y2")),
  ];

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : undefined },
    yaxis: {
      title: props.left_label ? { text: props.left_label } : undefined,
      type: props.left_log ? "log" : "linear",
    },
    yaxis2: {
      title: props.right_label ? { text: props.right_label } : undefined,
      type: props.right_log ? "log" : "linear",
      overlaying: "y",
      side: "right",
      showgrid: false,
    },
    barmode: "group",
    showlegend: true,
    legend: { orientation: "h", y: -0.2 },
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

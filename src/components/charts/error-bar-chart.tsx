"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, useColorMap, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface ErrorBarChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key: string;
  y_key: string;
  /** Symmetric error magnitude (e.g. SE, SD, half-CI-width) column. */
  error_key?: string | null;
  /** Asymmetric lower error magnitude column. When set, error_key is the upper. */
  error_minus_key?: string | null;
  /** Categorical column to split into multiple coloured series. */
  group_key?: string | null;
  mode?: "markers" | "bars" | null;
  y_log?: boolean | null;
  x_label?: string | null;
  y_label?: string | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

export function ErrorBarChartComponent({ props }: { props: ErrorBarChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const asBars = (props.mode ?? "markers") === "bars";
  const hasAsym = !!props.error_minus_key;

  // Split into series by group_key (or a single series).
  const groups: string[] = props.group_key
    ? Array.from(new Set(rows.map((r) => String(r[props.group_key!] ?? "—"))))
    : ["__all__"];
  const colors = useColorMap(groups, props.color_map);

  if (rows.length === 0) return <ChartEmptyState height={chart.height} />;

  const errPlus = (r: Record<string, unknown>) =>
    props.error_key != null ? Math.abs(Number(r[props.error_key]) || 0) : 0;
  const errMinus = (r: Record<string, unknown>) =>
    hasAsym ? Math.abs(Number(r[props.error_minus_key!]) || 0) : errPlus(r);

  const traces: Data[] = groups.map((g, i) => {
    const gr = props.group_key
      ? rows.filter((r) => String(r[props.group_key!] ?? "—") === g)
      : rows;
    const color = colors[i] ?? palette[i % palette.length];
    const errorY = props.error_key
      ? {
          type: "data" as const,
          symmetric: !hasAsym,
          array: gr.map(errPlus),
          ...(hasAsym ? { arrayminus: gr.map(errMinus) } : {}),
          color,
          thickness: 1.5,
          width: 4,
        }
      : undefined;
    return {
      type: asBars ? ("bar" as const) : ("scatter" as const),
      ...(asBars ? {} : { mode: "markers" as const }),
      x: gr.map((r) => r[props.x_key] as string | number),
      y: gr.map((r) => Number(r[props.y_key]) || 0),
      name: g === "__all__" ? (props.y_label ?? props.y_key) : g,
      marker: { color, size: asBars ? undefined : 7 },
      error_y: errorY,
      showlegend: g !== "__all__",
    };
  });

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : undefined },
    yaxis: {
      title: props.y_label ? { text: props.y_label } : undefined,
      type: props.y_log ? "log" : "linear",
    },
    barmode: "group",
    showlegend: !!props.group_key,
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

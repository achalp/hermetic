"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyFinanceChart } from "./plotly-finance-wrapper";
import { useChartColors, resolveColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface FunnelChartProps {
  title?: string | null;
  data: { label: string; value: number }[];
  orientation?: "vertical" | "horizontal" | null;
  /** Show conversion % relative to the first/previous stage. */
  show_percent?: "initial" | "previous" | "none" | null;
  colors?: string[] | null;
  height?: number | null;
}

export function FunnelChartComponent({ props }: { props: FunnelChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data) as unknown as { label: string; value: number }[];
  const stages = Array.isArray(rows)
    ? rows
        .filter((r) => r && r.label != null)
        .map((r) => ({ label: String(r.label), value: Number(r.value) || 0 }))
    : [];
  if (stages.length === 0) return <ChartEmptyState height={chart.height} />;

  const colors = props.colors ? resolveColors(props.colors) : palette;
  const horizontal = (props.orientation ?? "horizontal") === "horizontal";
  const percentMode = props.show_percent ?? "initial";

  const textinfo =
    percentMode === "none"
      ? "value"
      : percentMode === "previous"
        ? "value+percent previous"
        : "value+percent initial";

  const labels = stages.map((s) => s.label);
  const values = stages.map((s) => s.value);
  const trace: Data = {
    type: "funnel" as const,
    orientation: horizontal ? "h" : "v",
    // horizontal: categories on y, values on x; vertical: the reverse.
    x: horizontal ? values : labels,
    y: horizontal ? labels : values,
    textposition: "inside",
    textinfo,
    marker: { color: stages.map((_, i) => colors[i % colors.length]) },
    connector: { line: { color: "#9ca3af", width: 1 } },
  } as Data;

  const layout: Partial<Layout> = {
    margin: { l: horizontal ? 120 : 40, r: 20, t: 10, b: 40 },
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
        <PlotlyFinanceChart
          data={[trace]}
          layout={layout}
          height={isExpanded ? undefined : chartHeight}
        />
      </div>
    </div>
  );
}

"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface TernaryChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  a_key: string;
  b_key: string;
  c_key: string;
  a_label?: string | null;
  b_label?: string | null;
  c_label?: string | null;
  group_key?: string | null;
  size_key?: string | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

export function TernaryChartComponent({ props }: { props: TernaryChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const groups: string[] = props.group_key
    ? Array.from(new Set(rows.map((r) => String(r[props.group_key!] ?? "—"))))
    : ["__all__"];
  const colors = useColorMap(groups, props.color_map);

  if (rows.length === 0) return <ChartEmptyState height={chart.height} />;

  const traces: Data[] = groups.map((g, i) => {
    const gr = props.group_key
      ? rows.filter((r) => String(r[props.group_key!] ?? "—") === g)
      : rows;
    return {
      type: "scatterternary" as const,
      mode: "markers" as const,
      a: gr.map((r) => Number(r[props.a_key]) || 0),
      b: gr.map((r) => Number(r[props.b_key]) || 0),
      c: gr.map((r) => Number(r[props.c_key]) || 0),
      name: g === "__all__" ? "Points" : g,
      marker: {
        color: colors[i] ?? palette[i % palette.length],
        size: props.size_key ? gr.map((r) => Math.max(5, Number(r[props.size_key!]) || 6)) : 8,
        opacity: 0.75,
        line: { width: 0.5, color: "#ffffff" },
      },
      showlegend: g !== "__all__",
    } as Data;
  });

  const layout: Partial<Layout> = {
    ternary: {
      sum: 1,
      aaxis: { title: { text: props.a_label ?? props.a_key } },
      baxis: { title: { text: props.b_label ?? props.b_key } },
      caxis: { title: { text: props.c_label ?? props.c_key } },
    },
    showlegend: !!props.group_key,
  } as Partial<Layout>;

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

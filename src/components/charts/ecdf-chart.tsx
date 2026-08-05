"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors, unwrapChartData } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface ECDFChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  /** Optional categorical column for one ECDF per group. */
  group_key?: string | null;
  x_label?: string | null;
  /** Show survival (1-CDF) instead of the cumulative distribution. */
  complementary?: boolean | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

function ecdf(values: number[], complementary: boolean): { x: number[]; y: number[] } {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i + 1) / n;
    x.push(sorted[i]);
    y.push(complementary ? 1 - p : p);
  }
  return { x, y };
}

export function ECDFChartComponent({ props }: { props: ECDFChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);
  const complementary = props.complementary ?? false;

  const groups: string[] = props.group_key
    ? Array.from(new Set(rows.map((r) => String(r[props.group_key!] ?? "—"))))
    : ["__all__"];
  const colors = useColorMap(groups, props.color_map);

  if (rows.length === 0) return <ChartEmptyState height={chart.height} />;

  const traces: Data[] = groups.map((g, i) => {
    const gr = props.group_key
      ? rows.filter((r) => String(r[props.group_key!] ?? "—") === g)
      : rows;
    const { x, y } = ecdf(
      gr.map((r) => Number(r[props.value_key])),
      complementary
    );
    return {
      type: "scatter" as const,
      mode: "lines" as const,
      line: { shape: "hv" as const, color: colors[i] ?? palette[i % palette.length], width: 2 },
      x,
      y,
      name: g === "__all__" ? "ECDF" : g,
      showlegend: g !== "__all__",
    };
  });

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : { text: props.value_key } },
    yaxis: {
      title: { text: complementary ? "1 − F(x)" : "Cumulative proportion" },
      range: [0, 1.02],
    },
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

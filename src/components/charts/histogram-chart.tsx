"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface HistogramChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  group_key?: string | null;
  nbins?: number | null;
  color_map?: Record<string, string> | null;
  normalize?: boolean | null;
}

export function HistogramChartComponent({ props }: { props: HistogramChartProps }) {
  const { chart } = useThemeConfig();
  const rows = Array.isArray(props.data) ? props.data : [];

  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const groupName = props.group_key ? String(row[props.group_key] ?? "Other") : "all";
    const val = Number(row[props.value_key]);
    if (!isNaN(val)) {
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(val);
    }
  }

  const groupNames = [...groups.keys()];
  const colors = useColorMap(groupNames, props.color_map);

  if (rows.length === 0) return <div style={{ height: chart.height }} />;
  const hasMultipleGroups = groupNames.length > 1;

  const traces: Data[] = groupNames.map((name, i) => ({
    type: "histogram" as const,
    x: groups.get(name)!,
    name: hasMultipleGroups ? name : undefined,
    nbinsx: props.nbins ?? undefined,
    histnorm: props.normalize ? ("probability" as const) : undefined,
    opacity: hasMultipleGroups ? 0.7 : 1,
    marker: { color: colors[i] },
  }));

  const layout: Partial<Layout> = {
    barmode: hasMultipleGroups ? "overlay" : undefined,
    showlegend: hasMultipleGroups,
  };

  return (
    <div className="w-full">
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
        </h3>
      )}
      <PlotlyChart data={traces} layout={layout} height={chart.height} />
    </div>
  );
}

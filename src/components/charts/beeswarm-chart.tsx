"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface BeeswarmChartProps {
  title: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  group_key: string | null;
  color_map: Record<string, string> | null;
  marker_size: number | null;
}

export function BeeswarmChartComponent({ props }: { props: BeeswarmChartProps }) {
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

  const traces: Data[] = groupNames.map((name, i) => {
    const values = groups.get(name)!;
    // Deterministic jitter based on index to avoid impure Math.random in render
    const jitter = values.map((_, vi) => {
      const hash = ((vi * 2654435761) >>> 0) / 4294967296;
      return (hash - 0.5) * 0.4;
    });
    return {
      type: "scatter" as const,
      x: values,
      y: jitter.map((j) => i + j),
      mode: "markers" as const,
      name,
      marker: {
        color: colors[i],
        size: props.marker_size ?? 6,
        opacity: 0.7,
      },
    };
  });

  const layout: Partial<Layout> = {
    showlegend: groupNames.length > 1,
    yaxis: {
      tickvals: groupNames.map((_, i) => i),
      ticktext: groupNames,
    },
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

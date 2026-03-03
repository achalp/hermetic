"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface RidgelineChartProps {
  title: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  group_key: string;
  overlap: number | null;
  color_map: Record<string, string> | null;
}

export function RidgelineChartComponent({ props }: { props: RidgelineChartProps }) {
  const { chart } = useThemeConfig();
  const rows = Array.isArray(props.data) ? props.data : [];

  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const groupName = String(row[props.group_key] ?? "Other");
    const val = Number(row[props.value_key]);
    if (!isNaN(val)) {
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName)!.push(val);
    }
  }

  const groupNames = [...groups.keys()];
  const colors = useColorMap(groupNames, props.color_map);

  if (groupNames.length === 0) return <div style={{ height: chart.height }} />;

  const traces: Data[] = groupNames.map((name, i) => ({
    type: "violin" as const,
    x: groups.get(name)!,
    name,
    side: "positive" as const,
    line: { color: colors[i], width: 2 },
    fillcolor: colors[i] + "60",
    meanline: { visible: true },
    scalemode: "width" as const,
    y0: i * (props.overlap ?? 0.5),
  }));

  const layout: Partial<Layout> = {
    showlegend: true,
    xaxis: { zeroline: false },
    yaxis: { showticklabels: false, zeroline: false },
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

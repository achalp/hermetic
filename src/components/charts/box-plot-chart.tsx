"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";

interface BoxPlotChartProps {
  title?: string | null;
  data: Record<string, unknown>[];
  value_key: string;
  group_key?: string | null;
  orientation?: "vertical" | "horizontal" | null;
  show_points?: boolean | null;
  color_map?: Record<string, string> | null;
}

export function BoxPlotChartComponent({ props }: { props: BoxPlotChartProps }) {
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
  const isHorizontal = props.orientation === "horizontal";

  const traces: Data[] = groupNames.map((name, i) => {
    const values = groups.get(name)!;
    const trace: Data = {
      type: "box" as const,
      name,
      marker: { color: colors[i] },
      ...(props.show_points ? { boxpoints: "all" as const, jitter: 0.3, pointpos: -1.8 } : {}),
    };
    if (isHorizontal) {
      (trace as Record<string, unknown>).x = values;
    } else {
      (trace as Record<string, unknown>).y = values;
    }
    return trace;
  });

  const layout: Partial<Layout> = {
    boxmode: "group",
    showlegend: groupNames.length > 1,
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

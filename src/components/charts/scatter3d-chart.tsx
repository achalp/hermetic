"use client";

import type { Data, Layout } from "plotly.js";
import { Plotly3DChart } from "./plotly-3d-wrapper";
import { useColorMap, useChartColors } from "@/lib/chart-theme";

interface Scatter3DProps {
  title?: string | null;
  data: Record<string, unknown>[];
  x_key: string;
  y_key: string;
  z_key: string;
  x_label?: string | null;
  y_label?: string | null;
  z_label?: string | null;
  group_key?: string | null;
  size_key?: string | null;
  color_map?: Record<string, string> | null;
  mode?: "markers" | "lines" | "lines+markers" | null;
}

export function Scatter3DChartComponent({ props }: { props: Scatter3DProps }) {
  const chartColors = useChartColors();
  const data = Array.isArray(props.data) ? props.data : [];

  // Build groups unconditionally so useColorMap is always called
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of data) {
    const key = props.group_key ? String(row[props.group_key] ?? "Other") : "__all__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  const groupNames = [...groups.keys()];
  const colors = useColorMap(groupNames, props.color_map);

  if (data.length === 0) {
    return <div style={{ height: 500 }} />;
  }

  const traceMode = props.mode ?? "markers";

  const traces: Data[] = [];

  if (props.group_key) {
    for (const [i, name] of groupNames.entries()) {
      const rows = groups.get(name)!;
      traces.push({
        type: "scatter3d" as const,
        mode: traceMode as "markers",
        name,
        x: rows.map((r) => Number(r[props.x_key])),
        y: rows.map((r) => Number(r[props.y_key])),
        z: rows.map((r) => Number(r[props.z_key])),
        marker: {
          size: props.size_key ? rows.map((r) => Math.max(2, Number(r[props.size_key!]) || 4)) : 4,
          color: colors[i],
          opacity: 0.8,
        },
      });
    }
  } else {
    traces.push({
      type: "scatter3d" as const,
      mode: traceMode as "markers",
      x: data.map((r) => Number(r[props.x_key])),
      y: data.map((r) => Number(r[props.y_key])),
      z: data.map((r) => Number(r[props.z_key])),
      marker: {
        size: props.size_key ? data.map((r) => Math.max(2, Number(r[props.size_key!]) || 4)) : 4,
        color: chartColors[0],
        opacity: 0.8,
      },
    });
  }

  const layout: Partial<Layout> = {
    scene: {
      xaxis: { title: props.x_label ?? props.x_key },
      yaxis: { title: props.y_label ?? props.y_key },
      zaxis: { title: props.z_label ?? props.z_key },
    } as Layout["scene"],
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
      <Plotly3DChart data={traces} layout={layout} />
    </div>
  );
}

"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface GanttTask {
  task: string;
  start: string | number;
  end: string | number;
  group?: string | null;
}

interface GanttChartProps {
  title?: string | null;
  tasks: GanttTask[];
  color_map?: Record<string, string> | null;
  height?: number | null;
}

function toMs(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function GanttChartComponent({ props }: { props: GanttChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.tasks) as unknown as GanttTask[];

  const tasks = (Array.isArray(rows) ? rows : [])
    .map((t) => ({ ...t, s: toMs(t.start), e: toMs(t.end) }))
    .filter((t) => t.task != null && t.s != null && t.e != null && t.e! >= t.s!);

  const groups = Array.from(new Set(tasks.map((t) => String(t.group ?? "—"))));
  const colors = useColorMap(groups, props.color_map);

  if (tasks.length === 0) return <ChartEmptyState height={chart.height} />;

  // Reverse so the first task appears at the top.
  const ordered = [...tasks].reverse();

  // One bar trace per group for a meaningful legend.
  const traces: Data[] = groups.map((g, i) => {
    const gt = ordered.filter((t) => String(t.group ?? "—") === g);
    return {
      type: "bar" as const,
      orientation: "h" as const,
      base: gt.map((t) => t.s as number),
      x: gt.map((t) => (t.e as number) - (t.s as number)),
      y: gt.map((t) => t.task),
      name: g === "—" ? "Tasks" : g,
      marker: { color: colors[i] ?? palette[i % palette.length] },
      hovertemplate: "%{y}<extra></extra>",
      showlegend: g !== "—",
    } as Data;
  });

  const layout: Partial<Layout> = {
    barmode: "overlay",
    xaxis: { type: "date", title: undefined },
    yaxis: { automargin: true },
    showlegend: groups.length > 1 || groups[0] !== "—",
    margin: { l: 140, r: 24, t: 10, b: 40 },
  };

  const chartHeight = props.height ?? Math.max(chart.height, 60 + tasks.length * 26);

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

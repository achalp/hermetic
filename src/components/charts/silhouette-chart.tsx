"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { mean } from "@/lib/chart-stats";

interface SilhouetteProps {
  title?: string | null;
  /** One row per sample with its cluster and silhouette coefficient. */
  data: Record<string, unknown>[];
  cluster_key: string;
  value_key: string;
  /** Average silhouette score reference line; computed if omitted. */
  avg_silhouette?: number | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

export function SilhouetteComponent({ props }: { props: SilhouetteProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data);

  const clusters = Array.from(new Set(rows.map((r) => String(r[props.cluster_key] ?? "—")))).sort();
  const colors = useColorMap(clusters, props.color_map);

  if (rows.length === 0) return <div style={{ height: chart.height }} />;

  // Lay samples out bottom-to-top, grouped by cluster, sorted ascending within
  // each so each cluster forms a smooth widening wedge.
  let y = 0;
  const gap = Math.max(2, Math.round(rows.length * 0.02));
  const traces: Data[] = clusters.map((c, i) => {
    const vals = rows
      .filter((r) => String(r[props.cluster_key] ?? "—") === c)
      .map((r) => Number(r[props.value_key]))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    const ys = vals.map(() => y++);
    y += gap;
    return {
      type: "bar" as const,
      orientation: "h" as const,
      x: vals,
      y: ys,
      name: `Cluster ${c}`,
      marker: { color: colors[i] ?? palette[i % palette.length], line: { width: 0 } },
      width: 1,
    };
  });

  const allVals = rows.map((r) => Number(r[props.value_key])).filter((v) => Number.isFinite(v));
  const avg = props.avg_silhouette ?? mean(allVals);

  const layout: Partial<Layout> = {
    barmode: "overlay",
    bargap: 0,
    xaxis: { title: { text: "Silhouette coefficient" }, zeroline: true },
    yaxis: { showticklabels: false, title: { text: "Samples (grouped by cluster)" } },
    showlegend: clusters.length > 1,
    shapes: [
      {
        type: "line",
        yref: "paper",
        y0: 0,
        y1: 1,
        xref: "x",
        x0: avg,
        x1: avg,
        line: { color: "#dc2626", width: 1, dash: "dash" },
        label: { text: `avg ${avg.toFixed(2)}`, font: { size: 10, color: "#dc2626" } },
      },
    ],
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

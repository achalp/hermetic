"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface SurvivalPoint {
  time: number;
  survival: number;
  lower?: number | null;
  upper?: number | null;
}

interface SurvivalCurve {
  label: string;
  points: SurvivalPoint[];
}

interface SurvivalChartProps {
  title?: string | null;
  curves: SurvivalCurve[];
  x_label?: string | null;
  y_label?: string | null;
  show_ci?: boolean | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

/** Convert hex (#rgb/#rrggbb) to an rgba() string at the given alpha. */
function rgba(hex: string, alpha: number): string {
  let h = hex.replace("#", "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function SurvivalChartComponent({ props }: { props: SurvivalChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const curves = Array.isArray(props.curves) ? props.curves : [];
  const labels = curves.map((c) => c.label);
  const colors = useColorMap(labels, props.color_map);
  const showCi = props.show_ci ?? true;

  if (curves.length === 0) return <ChartEmptyState height={chart.height} />;

  const traces: Data[] = [];
  curves.forEach((curve, i) => {
    const pts = Array.isArray(curve.points) ? curve.points : [];
    const color = colors[i] ?? palette[i % palette.length];
    const x = pts.map((p) => p.time);

    const hasCi = showCi && pts.some((p) => p.lower != null && p.upper != null);
    if (hasCi) {
      // Upper then lower with fill between for the confidence band.
      traces.push({
        type: "scatter" as const,
        mode: "lines" as const,
        line: { shape: "hv" as const, width: 0 },
        x,
        y: pts.map((p) => p.upper ?? p.survival),
        hoverinfo: "skip" as const,
        showlegend: false,
      });
      traces.push({
        type: "scatter" as const,
        mode: "lines" as const,
        line: { shape: "hv" as const, width: 0 },
        fill: "tonexty" as const,
        fillcolor: rgba(color, 0.15),
        x,
        y: pts.map((p) => p.lower ?? p.survival),
        hoverinfo: "skip" as const,
        showlegend: false,
      });
    }

    traces.push({
      type: "scatter" as const,
      mode: "lines" as const,
      line: { shape: "hv" as const, color, width: 2 },
      x,
      y: pts.map((p) => p.survival),
      name: curve.label,
    });
  });

  const layout: Partial<Layout> = {
    xaxis: { title: { text: props.x_label ?? "Time" } },
    yaxis: { title: { text: props.y_label ?? "Survival probability" }, range: [0, 1.02] },
    showlegend: curves.length > 1,
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

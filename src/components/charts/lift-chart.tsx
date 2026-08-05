"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface LiftCurve {
  label: string;
  /** Fraction of population targeted (0..1) or decile index. */
  x: number[];
  /** Lift (×) or cumulative gain (0..1) at each x. */
  y: number[];
}

interface LiftChartProps {
  title?: string | null;
  curves: LiftCurve[];
  kind?: "lift" | "gain" | null;
  show_baseline?: boolean | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

export function LiftChartComponent({ props }: { props: LiftChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const curves = Array.isArray(props.curves) ? props.curves : [];
  const labels = curves.map((c) => c.label);
  const colors = useColorMap(labels, props.color_map);
  const isGain = (props.kind ?? "lift") === "gain";

  if (curves.length === 0) return <ChartEmptyState height={chart.height} />;

  const traces: Data[] = curves.map((curve, i) => ({
    type: "scatter" as const,
    mode: "lines" as const,
    x: Array.isArray(curve.x) ? curve.x : [],
    y: Array.isArray(curve.y) ? curve.y : [],
    name: curve.label,
    line: { color: colors[i] ?? palette[i % palette.length], width: 2 },
  }));

  if (props.show_baseline ?? true) {
    // Lift baseline is a flat line at 1×; gain baseline is the diagonal.
    traces.push({
      type: "scatter" as const,
      mode: "lines" as const,
      x: [0, 1],
      y: isGain ? [0, 1] : [1, 1],
      name: "Baseline",
      line: { color: "#9ca3af", width: 1, dash: "dash" },
      showlegend: false,
    });
  }

  const layout: Partial<Layout> = {
    xaxis: { title: { text: "Fraction of population" }, range: [0, 1] },
    yaxis: { title: { text: isGain ? "Cumulative gain" : "Lift (×)" } },
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

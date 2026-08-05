"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useColorMap, useChartColors } from "@/components/theme/chart-theme";
import { useThemeConfig } from "@/components/theme/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface CalibrationCurve {
  label: string;
  predicted: number[];
  observed: number[];
}

interface CalibrationCurveProps {
  title?: string | null;
  curves: CalibrationCurve[];
  show_diagonal?: boolean | null;
  color_map?: Record<string, string> | null;
  height?: number | null;
}

export function CalibrationCurveComponent({ props }: { props: CalibrationCurveProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const curves = Array.isArray(props.curves) ? props.curves : [];
  const labels = curves.map((c) => c.label);
  const colors = useColorMap(labels, props.color_map);

  if (curves.length === 0) return <ChartEmptyState height={chart.height} />;

  const traces: Data[] = curves.map((curve, i) => ({
    type: "scatter" as const,
    mode: "lines+markers" as const,
    x: Array.isArray(curve.predicted) ? curve.predicted : [],
    y: Array.isArray(curve.observed) ? curve.observed : [],
    name: curve.label,
    line: { color: colors[i] ?? palette[i % palette.length], width: 2 },
    marker: { size: 6 },
  }));

  if (props.show_diagonal ?? true) {
    traces.push({
      type: "scatter" as const,
      mode: "lines" as const,
      x: [0, 1],
      y: [0, 1],
      name: "Perfectly calibrated",
      line: { color: "#9ca3af", width: 1, dash: "dash" },
      showlegend: false,
    });
  }

  const layout: Partial<Layout> = {
    xaxis: { title: { text: "Mean predicted probability" }, range: [0, 1] },
    yaxis: { title: { text: "Fraction of positives" }, range: [0, 1.02] },
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

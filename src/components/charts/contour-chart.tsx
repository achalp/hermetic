"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";
import { ChartEmptyState } from "./chart-empty-state";

interface ContourChartProps {
  title?: string | null;
  /** 2D grid of z values (rows = y, cols = x). */
  z: number[][];
  /** Optional x/y coordinate axes (numeric); default to indices. */
  x?: number[] | null;
  y?: number[] | null;
  x_label?: string | null;
  y_label?: string | null;
  filled?: boolean | null;
  ncontours?: number | null;
  colorscale?: string | null;
  height?: number | null;
}

export function ContourChartComponent({ props }: { props: ContourChartProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const z = Array.isArray(props.z) ? props.z : [];

  if (z.length === 0 || !Array.isArray(z[0])) return <ChartEmptyState height={chart.height} />;

  const trace: Data = {
    type: "contour" as const,
    z,
    x: Array.isArray(props.x) ? props.x : undefined,
    y: Array.isArray(props.y) ? props.y : undefined,
    colorscale: (props.colorscale ?? "Viridis") as string,
    contours: { coloring: (props.filled ?? true) ? "fill" : "lines" },
    ncontours: props.ncontours ?? undefined,
    line: { width: (props.filled ?? true) ? 0.5 : 1.5 },
  } as Data;

  const layout: Partial<Layout> = {
    xaxis: { title: props.x_label ? { text: props.x_label } : undefined },
    yaxis: { title: props.y_label ? { text: props.y_label } : undefined },
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
        <PlotlyChart data={[trace]} layout={layout} height={isExpanded ? undefined : chartHeight} />
      </div>
    </div>
  );
}

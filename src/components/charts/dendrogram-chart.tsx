"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface DendrogramProps {
  title?: string | null;
  /** scipy dendrogram icoord: each entry is the 4 x-coords of one U-link. */
  icoord: number[][];
  /** scipy dendrogram dcoord: each entry is the 4 y-coords (distances) of one link. */
  dcoord: number[][];
  /** Leaf labels in left-to-right order (scipy 'ivl'). */
  labels?: string[] | null;
  orientation?: "top" | "left" | null;
  color?: string | null;
  height?: number | null;
}

export function DendrogramComponent({ props }: { props: DendrogramProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const icoord = Array.isArray(props.icoord) ? props.icoord : [];
  const dcoord = Array.isArray(props.dcoord) ? props.dcoord : [];

  if (icoord.length === 0 || icoord.length !== dcoord.length)
    return <div style={{ height: chart.height }} />;

  const color = props.color ?? palette[0];
  const horizontal = (props.orientation ?? "top") === "left";

  // Each link is a U shape of 4 points; null-gap between links.
  const xs: (number | null)[] = [];
  const ys: (number | null)[] = [];
  for (let i = 0; i < icoord.length; i++) {
    const ic = icoord[i];
    const dc = dcoord[i];
    if (!Array.isArray(ic) || !Array.isArray(dc)) continue;
    for (let j = 0; j < 4; j++) {
      // 'left' orientation swaps the axes (distance grows horizontally).
      xs.push(horizontal ? dc[j] : ic[j]);
      ys.push(horizontal ? ic[j] : dc[j]);
    }
    xs.push(null);
    ys.push(null);
  }

  const trace: Data = {
    type: "scatter" as const,
    mode: "lines" as const,
    x: xs,
    y: ys,
    line: { color, width: 1.5 },
    hoverinfo: "skip" as const,
    showlegend: false,
  };

  // Leaf positions in scipy are 5, 15, 25, ... (10*i + 5).
  const labels = Array.isArray(props.labels) ? props.labels : [];
  const leafPos = labels.map((_, i) => 10 * i + 5);
  const leafAxis = {
    tickmode: "array" as const,
    tickvals: leafPos,
    ticktext: labels,
    showgrid: false,
    zeroline: false,
  };
  const distAxis = { title: { text: "Distance" }, showgrid: true, zeroline: false };

  const layout: Partial<Layout> = horizontal
    ? { xaxis: distAxis, yaxis: { ...leafAxis, automargin: true } }
    : { xaxis: { ...leafAxis, automargin: true }, yaxis: distAxis };

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

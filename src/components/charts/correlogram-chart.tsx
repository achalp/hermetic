"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyChart } from "./plotly-wrapper";
import { useChartColors, unwrapChartData } from "@/lib/chart-theme";
import { useThemeConfig } from "@/lib/theme-config";
import { useChartExpanded } from "./chart-expand-wrapper";

interface CorrelogramProps {
  title?: string | null;
  /** One row per lag: {lag, value} where value is the ACF/PACF coefficient. */
  data: { lag: number; value: number }[];
  /** Sample size, used to draw the ±1.96/√n significance band. */
  n?: number | null;
  /** Explicit band half-width (overrides n). */
  conf_band?: number | null;
  kind?: "acf" | "pacf" | null;
  color?: string | null;
  height?: number | null;
}

export function CorrelogramComponent({ props }: { props: CorrelogramProps }) {
  const { chart } = useThemeConfig();
  const isExpanded = useChartExpanded();
  const palette = useChartColors();
  const rows = unwrapChartData(props.data) as unknown as { lag: number; value: number }[];

  const items = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && Number.isFinite(Number(r.lag)) && Number.isFinite(Number(r.value)))
    .map((r) => ({ lag: Number(r.lag), value: Number(r.value) }))
    .sort((a, b) => a.lag - b.lag);

  if (items.length === 0) return <div style={{ height: chart.height }} />;

  const color = props.color ?? palette[0];

  // Stems: a single line trace with null gaps between each (lag,0)->(lag,value).
  const stemX: (number | null)[] = [];
  const stemY: (number | null)[] = [];
  for (const it of items) {
    stemX.push(it.lag, it.lag, null);
    stemY.push(0, it.value, null);
  }

  const traces: Data[] = [
    {
      type: "scatter" as const,
      mode: "lines" as const,
      x: stemX,
      y: stemY,
      line: { color, width: 1.5 },
      hoverinfo: "skip" as const,
      showlegend: false,
    },
    {
      type: "scatter" as const,
      mode: "markers" as const,
      x: items.map((r) => r.lag),
      y: items.map((r) => r.value),
      marker: { color, size: 7 },
      name: (props.kind ?? "acf").toUpperCase(),
      showlegend: false,
    },
  ];

  const band =
    props.conf_band != null
      ? Math.abs(props.conf_band)
      : props.n && props.n > 0
        ? 1.96 / Math.sqrt(props.n)
        : null;

  const layout: Partial<Layout> = {
    xaxis: { title: { text: "Lag" }, zeroline: false },
    yaxis: {
      title: { text: (props.kind ?? "acf") === "pacf" ? "PACF" : "ACF" },
      range: [-1.05, 1.05],
    },
    showlegend: false,
    shapes: [
      {
        type: "line",
        xref: "paper",
        x0: 0,
        x1: 1,
        yref: "y",
        y0: 0,
        y1: 0,
        line: { color: "#9ca3af", width: 1 },
      },
      ...(band != null
        ? [
            {
              type: "rect" as const,
              xref: "paper" as const,
              x0: 0,
              x1: 1,
              yref: "y" as const,
              y0: -band,
              y1: band,
              fillcolor: "rgba(59, 110, 240, 0.10)",
              line: { width: 0 },
            },
          ]
        : []),
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

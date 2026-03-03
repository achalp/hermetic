"use client";

import type { Data, Layout } from "plotly.js";
import { PlotlyFinanceChart } from "./plotly-finance-wrapper";
import { useThemeConfig } from "@/lib/theme-config";
import { resolveColor } from "@/lib/chart-theme";

interface WaterfallChartProps {
  title: string | null;
  data: { label: string; value: number; type: "absolute" | "relative" | "total" | null }[];
  orientation: "vertical" | "horizontal" | null;
  increasing_color: string | null;
  decreasing_color: string | null;
  total_color: string | null;
}

export function WaterfallChartComponent({ props }: { props: WaterfallChartProps }) {
  const { chart } = useThemeConfig();
  const data = Array.isArray(props.data) ? props.data : [];

  if (data.length === 0) return <div style={{ height: chart.height }} />;

  const isHorizontal = props.orientation === "horizontal";
  const labels = data.map((d) => d.label);
  const values = data.map((d) => d.value);
  const measures = data.map((d) => d.type ?? "relative");

  const incColor = resolveColor(props.increasing_color ?? "#22c55e");
  const decColor = resolveColor(props.decreasing_color ?? "#ef4444");
  const totColor = resolveColor(props.total_color ?? "#3b82f6");

  const traces: Data[] = [
    {
      type: "waterfall",
      orientation: isHorizontal ? "h" : "v",
      x: isHorizontal ? values : labels,
      y: isHorizontal ? labels : values,
      measure: measures,
      increasing: { marker: { color: incColor } },
      decreasing: { marker: { color: decColor } },
      totals: { marker: { color: totColor } },
      connector: { line: { color: "rgb(63, 63, 63)", width: 1 } },
    } as unknown as Data,
  ];

  const layout: Partial<Layout> = {
    showlegend: false,
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
      <PlotlyFinanceChart data={traces} layout={layout} height={chart.height} />
    </div>
  );
}

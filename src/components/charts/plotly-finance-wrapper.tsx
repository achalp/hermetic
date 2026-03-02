"use client";

import dynamic from "next/dynamic";
import type { Data, Layout, Config } from "plotly.js";
import { usePlotlyLayout } from "@/lib/chart-theme";

const PlotlyPlot = dynamic(
  async () => {
    const Plotly = await import("plotly.js-finance-dist");
    const createPlotlyComponent = (await import("react-plotly.js/factory"))
      .default;
    return createPlotlyComponent(Plotly);
  },
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[400px] w-full items-center justify-center rounded-lg bg-surface-2">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent" />
      </div>
    ),
  }
);

const PLOTLY_CONFIG: Partial<Config> = {
  displayModeBar: "hover",
  modeBarButtonsToRemove: ["lasso2d", "select2d", "toImage"],
  displaylogo: false,
  responsive: true,
};

export function PlotlyFinanceChart({
  data,
  layout,
  height = 400,
}: {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
}) {
  const baseLayout = usePlotlyLayout();

  const mergedLayout: Partial<Layout> = {
    ...(baseLayout as Partial<Layout>),
    ...layout,
    xaxis: {
      ...(baseLayout.xaxis as Partial<Layout["xaxis"]>),
      ...(layout?.xaxis as Partial<Layout["xaxis"]>),
    },
    yaxis: {
      ...(baseLayout.yaxis as Partial<Layout["yaxis"]>),
      ...(layout?.yaxis as Partial<Layout["yaxis"]>),
    },
  };

  return (
    <div style={{ height }}>
      <PlotlyPlot
        data={data}
        layout={mergedLayout}
        config={PLOTLY_CONFIG}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

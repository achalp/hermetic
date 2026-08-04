"use client";

import { clientLazy } from "@/components/lazy-client";
import type { Data, Layout, Config } from "plotly.js";
import { usePlotlyLayout } from "@/lib/chart-theme";

const PlotlyPlot = clientLazy(
  async () => {
    const Plotly = await import("plotly.js-finance-dist");
    const createPlotlyComponent = (await import("react-plotly.js/factory")).default;
    return createPlotlyComponent(Plotly);
  },
  <div className="flex h-[400px] w-full items-center justify-center rounded-lg bg-surface-2">
    <div className="h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent" />
  </div>
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
  height,
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
    <div style={{ height: height ?? "100%" }}>
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

"use client";

import type { Layout } from "plotly.js";
import { makePlotlyWrapper } from "./make-plotly-wrapper";
import { usePlotlyLayout } from "@/components/theme/chart-theme";

export const PlotlyChart = makePlotlyWrapper(() => import("plotly.js-cartesian-dist"), {
  fallback: (
    <div
      className="flex h-[350px] w-full items-center justify-center bg-surface-2"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent" />
    </div>
  ),
  useBaseLayout: usePlotlyLayout,
  mergeLayout: (baseLayout, layout) => ({
    ...(baseLayout as Partial<Layout>),
    ...layout,
    autosize: true,
    xaxis: {
      ...(baseLayout.xaxis as Partial<Layout["xaxis"]>),
      ...(layout?.xaxis as Partial<Layout["xaxis"]>),
    },
    yaxis: {
      ...(baseLayout.yaxis as Partial<Layout["yaxis"]>),
      ...(layout?.yaxis as Partial<Layout["yaxis"]>),
    },
  }),
  containerStyle: { minWidth: 0, width: "100%" },
});

"use client";

import { clientLazy } from "@/components/lazy-client";
import type { Data, Layout, Config } from "plotly.js";
import { usePlotly3DScene } from "@/lib/chart-theme";

const Plotly3DPlot = clientLazy(
  async () => {
    const Plotly = await import("plotly.js-gl3d-dist");
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

export function Plotly3DChart({
  data,
  layout,
  height,
}: {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
}) {
  const sceneLayout = usePlotly3DScene();
  const h = height;

  const mergedLayout: Partial<Layout> = {
    ...(sceneLayout as Partial<Layout>),
    ...layout,
    scene: {
      ...((sceneLayout as Record<string, unknown>).scene as object),
      ...(layout?.scene as object),
    },
  };

  return (
    <div style={{ height: h ?? "100%" }}>
      <Plotly3DPlot
        data={data}
        layout={mergedLayout}
        config={PLOTLY_CONFIG}
        useResizeHandler
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}

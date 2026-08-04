"use client";

import { clientLazy } from "@/components/lazy-client";
import type { Data, Layout, Config } from "plotly.js";
import { usePlotlyLayout } from "@/lib/chart-theme";

// Polar traces (barpolar / scatterpolar) ship in neither the cartesian nor the
// finance prebuilt bundle, so we assemble a minimal custom bundle from
// plotly.js/lib/core + the polar trace modules. Dynamically imported, so the
// extra weight only loads when a polar chart actually renders.
const PlotlyPlot = clientLazy(
  async () => {
    // lib/* modules are CommonJS (module.exports = ...), so unwrap .default
    // defensively to stay correct under either interop mode.
    const unwrap = <T,>(m: T | { default: T }): T => (m as { default?: T }).default ?? (m as T);
    const Plotly = unwrap(await import("plotly.js/lib/core")) as {
      register: (m: unknown[]) => void;
    };
    const barpolar = unwrap(await import("plotly.js/lib/barpolar"));
    const scatterpolar = unwrap(await import("plotly.js/lib/scatterpolar"));
    Plotly.register([barpolar, scatterpolar]);
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

export function PlotlyPolarChart({
  data,
  layout,
  height,
}: {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
}) {
  const baseLayout = usePlotlyLayout();

  // Merge only the chrome (fonts/colors/paper) from the base layout; polar
  // charts use `polar`, not xaxis/yaxis, so those are intentionally dropped.
  const chrome: Partial<Layout> = { ...(baseLayout as Partial<Layout>) };
  delete chrome.xaxis;
  delete chrome.yaxis;
  const mergedLayout: Partial<Layout> = {
    ...chrome,
    ...layout,
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

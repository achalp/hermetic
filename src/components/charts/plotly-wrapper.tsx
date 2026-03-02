"use client";

import dynamic from "next/dynamic";
import type { Data, Layout, Config } from "plotly.js";
import { usePlotlyLayout } from "@/lib/chart-theme";
import { useRef, useEffect } from "react";

const PlotlyPlot = dynamic(
  async () => {
    const Plotly = await import("plotly.js-cartesian-dist");
    const createPlotlyComponent = (await import("react-plotly.js/factory")).default;
    return createPlotlyComponent(Plotly);
  },
  {
    ssr: false,
    loading: () => (
      <div
        className="flex h-[350px] w-full items-center justify-center bg-surface-2"
        style={{ borderRadius: "var(--radius-card)" }}
      >
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

export function PlotlyChart({
  data,
  layout,
  height = 350,
}: {
  data: Data[];
  layout?: Partial<Layout>;
  height?: number;
}) {
  const baseLayout = usePlotlyLayout();
  const containerRef = useRef<HTMLDivElement>(null);

  // Observe the container for size changes. When inside a CSS grid cell,
  // Plotly can render at 0-width before the grid assigns track sizes,
  // leaving charts (especially heatmaps) blank. ResizeObserver catches
  // the grid settling and forces Plotly to recalculate.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      const plotDiv = el.querySelector(".js-plotly-plot") as HTMLElement | null;
      if (!plotDiv) return;
      import("plotly.js-cartesian-dist").then((Plotly) => {
        if (disposed || !plotDiv.isConnected) return;
        try {
          Plotly.Plots.resize(plotDiv);
        } catch {
          /* element detached */
        }
      });
    });
    ro.observe(el);
    return () => {
      disposed = true;
      ro.disconnect();
    };
  }, []);

  const mergedLayout: Partial<Layout> = {
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
  };

  return (
    <div ref={containerRef} style={{ height, minWidth: 0, width: "100%" }}>
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

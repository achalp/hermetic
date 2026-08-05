"use client";

import type { Layout } from "plotly.js";
import { makePlotlyWrapper } from "./make-plotly-wrapper";
import { usePlotly3DScene } from "@/components/theme/chart-theme";

export const Plotly3DChart = makePlotlyWrapper(() => import("plotly.js-gl3d-dist"), {
  fallback: (
    <div className="flex h-[400px] w-full items-center justify-center rounded-lg bg-surface-2">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent" />
    </div>
  ),
  useBaseLayout: usePlotly3DScene,
  mergeLayout: (sceneLayout, layout) => ({
    ...(sceneLayout as Partial<Layout>),
    ...layout,
    scene: {
      ...(sceneLayout.scene as object),
      ...(layout?.scene as object),
    },
  }),
});

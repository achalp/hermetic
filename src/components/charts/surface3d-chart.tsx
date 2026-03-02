"use client";

import type { Data, Layout } from "plotly.js";
import { Plotly3DChart } from "./plotly-3d-wrapper";

interface Surface3DProps {
  title?: string | null;
  z: number[][];
  x_labels?: (string | number)[] | null;
  y_labels?: (string | number)[] | null;
  x_label?: string | null;
  y_label?: string | null;
  z_label?: string | null;
  color_scale?: string | null;
  show_wireframe?: boolean | null;
  opacity?: number | null;
}

export function Surface3DChartComponent({ props }: { props: Surface3DProps }) {
  if (!props.z || props.z.length === 0) {
    return <div style={{ height: 500 }} />;
  }

  // Wireframe uses a semi-transparent overlay that adapts to theme via CSS
  const wireColor = "rgba(128,128,128,0.3)";

  const traces: Data[] = [
    {
      type: "surface" as const,
      z: props.z,
      x: props.x_labels ?? undefined,
      y: props.y_labels ?? undefined,
      colorscale: (props.color_scale ?? "Viridis") as Plotly.ColorScale,
      opacity: props.opacity ?? 1,
      contours: props.show_wireframe
        ? {
            x: { show: true, color: wireColor },
            y: { show: true, color: wireColor },
            z: { show: true, color: wireColor },
          }
        : undefined,
    } as Data,
  ];

  const layout: Partial<Layout> = {
    scene: {
      xaxis: { title: props.x_label ?? undefined },
      yaxis: { title: props.y_label ?? undefined },
      zaxis: { title: props.z_label ?? undefined },
    } as Layout["scene"],
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
      <Plotly3DChart data={traces} layout={layout} />
    </div>
  );
}

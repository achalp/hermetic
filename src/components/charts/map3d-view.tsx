"use client";

import { Component, type ReactNode } from "react";
import dynamic from "next/dynamic";

const DeckGLMap = dynamic(() => import("./map3d-inner").then((m) => m.Map3DInner), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] w-full items-center justify-center rounded-lg bg-surface-2">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent" />
    </div>
  ),
});

interface Map3DProps {
  title?: string | null;
  data: Record<string, unknown>[];
  lat_key: string;
  lng_key: string;
  layer_type: "hexagon" | "column" | "arc" | "scatterplot" | "heatmap";
  value_key?: string | null;
  target_lat_key?: string | null;
  target_lng_key?: string | null;
  color_key?: string | null;
  color_map?: Record<string, string> | null;
  elevation_scale?: number | null;
  radius?: number | null;
  opacity?: number | null;
  pitch?: number | null;
  bearing?: number | null;
  height?: number | null;
}

class Map3DErrorBoundary extends Component<
  { height: number; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { height: number; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div
          className="flex items-center justify-center rounded-lg border border-border-default bg-surface-2 text-sm text-t-tertiary"
          style={{ height: this.props.height }}
        >
          3D map unavailable — WebGL not supported in this browser.
        </div>
      );
    }
    return this.props.children;
  }
}

export function Map3DComponent({ props }: { props: Map3DProps }) {
  if (!Array.isArray(props.data) || props.data.length === 0) {
    return <div style={{ height: props.height ?? 500 }} />;
  }

  const h = props.height ?? 500;

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
      <div
        className="overflow-hidden rounded-lg border border-border-default"
        style={{ height: h }}
      >
        <Map3DErrorBoundary height={h}>
          <DeckGLMap {...props} />
        </Map3DErrorBoundary>
      </div>
    </div>
  );
}

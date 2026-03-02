"use client";

import { useRef, useEffect, useSyncExternalStore, useState } from "react";
import dynamic from "next/dynamic";
import { resolveColor, useChartColors } from "@/lib/chart-theme";

const Globe = dynamic(() => import("react-globe.gl").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="flex h-[500px] w-full items-center justify-center rounded-lg bg-surface-2">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-border-default border-t-accent" />
    </div>
  ),
});

interface GlobePoint {
  lat: number;
  lng: number;
  label?: string | null;
  color?: string | null;
  size?: number | null;
}

interface GlobeArc {
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  label?: string | null;
  color?: string | null;
}

interface Globe3DProps {
  title?: string | null;
  points?: GlobePoint[] | null;
  arcs?: GlobeArc[] | null;
  globe_style?: "default" | "night" | "minimal" | null;
  auto_rotate?: boolean | null;
  height?: number | null;
}

const GLOBE_IMAGES: Record<string, string> = {
  default: "//unpkg.com/three-globe/example/img/earth-blue-marble.jpg",
  night: "//unpkg.com/three-globe/example/img/earth-night.jpg",
  minimal: "//unpkg.com/three-globe/example/img/earth-topology.png",
};

export function Globe3DComponent({ props }: { props: Globe3DProps }) {
  const chartColors = useChartColors();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globeEl = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dark = useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
    () => false
  );
  const [containerWidth, setContainerWidth] = useState(0);
  const height = props.height ?? 500;
  const style = props.globe_style ?? "default";
  const autoRotate = props.auto_rotate ?? true;

  // Measure container width and track resizes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setContainerWidth(w);
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const globe = globeEl.current;
    if (globe && typeof globe.controls === "function") {
      const controls = globe.controls();
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.5;
    }
  }, [autoRotate]);

  // Defensive: props may still be $chartData placeholder strings if replacement failed
  const points = Array.isArray(props.points)
    ? props.points.filter(
        (p) =>
          typeof p.lat === "number" && typeof p.lng === "number" && !isNaN(p.lat) && !isNaN(p.lng)
      )
    : [];
  const arcs = Array.isArray(props.arcs)
    ? props.arcs.filter(
        (a) =>
          typeof a.start_lat === "number" &&
          typeof a.end_lat === "number" &&
          !isNaN(a.start_lat) &&
          !isNaN(a.end_lat)
      )
    : [];
  const hasData = points.length > 0 || arcs.length > 0;

  if (!hasData) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-border-default text-sm text-t-tertiary"
        style={{ height }}
      >
        No geographic data to display
      </div>
    );
  }

  // Normalize point sizes to a visible range (0.2–1.5 globe-radius units).
  // The LLM may pass raw values like passenger counts (287,000) which would
  // cover the entire globe without normalization.
  const rawSizes = points.map((p) => p.size ?? 1);
  const minRaw = Math.min(...rawSizes);
  const maxRaw = Math.max(...rawSizes);
  const sizeRange = maxRaw - minRaw || 1;

  const pointsData = points.map((p, i) => ({
    lat: p.lat,
    lng: p.lng,
    label: p.label ?? "",
    color: p.color ? resolveColor(p.color) : chartColors[i % chartColors.length],
    size: 0.2 + ((rawSizes[i] - minRaw) / sizeRange) * 1.3,
  }));

  const arcsData = arcs.map((a) => ({
    startLat: a.start_lat,
    startLng: a.start_lng,
    endLat: a.end_lat,
    endLng: a.end_lng,
    label: a.label ?? "",
    color: a.color ? resolveColor(a.color) : chartColors[0],
  }));

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
        ref={containerRef}
        className="overflow-hidden rounded-lg border border-border-default"
        style={{ height }}
      >
        {containerWidth > 0 && (
          <Globe
            ref={globeEl}
            width={containerWidth}
            height={height}
            globeImageUrl={GLOBE_IMAGES[style]}
            backgroundColor={dark ? "#111827" : "#f9fafb"}
            pointsData={pointsData}
            pointLat="lat"
            pointLng="lng"
            pointLabel="label"
            pointColor="color"
            pointRadius="size"
            pointAltitude={0.01}
            arcsData={arcsData}
            arcStartLat="startLat"
            arcStartLng="startLng"
            arcEndLat="endLat"
            arcEndLng="endLng"
            arcLabel="label"
            arcColor="color"
            arcDashLength={0.4}
            arcDashGap={0.2}
            arcDashAnimateTime={1500}
          />
        )}
      </div>
    </div>
  );
}

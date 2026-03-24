"use client";

import { useRef, useEffect, useMemo, useSyncExternalStore, useState } from "react";
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

  // Coerce to numbers, filter out invalid entries
  const points = useMemo(
    () =>
      Array.isArray(props.points)
        ? props.points
            .map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng) }))
            .filter((p) => isFinite(p.lat) && isFinite(p.lng))
        : [],
    [props.points]
  );
  const arcs = useMemo(
    () =>
      Array.isArray(props.arcs)
        ? props.arcs
            .map((a) => ({
              ...a,
              start_lat: Number(a.start_lat),
              start_lng: Number(a.start_lng),
              end_lat: Number(a.end_lat),
              end_lng: Number(a.end_lng),
            }))
            .filter(
              (a) =>
                isFinite(a.start_lat) &&
                isFinite(a.end_lat) &&
                isFinite(a.start_lng) &&
                isFinite(a.end_lng)
            )
        : [],
    [props.arcs]
  );
  const hasData = points.length > 0 || arcs.length > 0;

  // Auto-rotate and auto-zoom to data extent
  useEffect(() => {
    const globe = globeEl.current;
    if (!globe) return;

    if (typeof globe.controls === "function") {
      const controls = globe.controls();
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.5;
    }

    if (!hasData) return;

    // Compute center and zoom from all data points
    const allLats: number[] = [];
    const allLngs: number[] = [];
    for (const p of points) {
      allLats.push(p.lat);
      allLngs.push(p.lng);
    }
    for (const a of arcs) {
      allLats.push(a.start_lat, a.end_lat);
      allLngs.push(a.start_lng, a.end_lng);
    }

    if (allLats.length > 0 && typeof globe.pointOfView === "function") {
      const centerLat = (Math.min(...allLats) + Math.max(...allLats)) / 2;
      const centerLng = (Math.min(...allLngs) + Math.max(...allLngs)) / 2;
      const latSpan = Math.max(...allLats) - Math.min(...allLats);
      const lngSpan = Math.max(...allLngs) - Math.min(...allLngs);
      const span = Math.max(latSpan, lngSpan, 0.1);
      // Altitude: higher for wider spans, lower for local data
      const altitude = Math.max(0.1, Math.min(span * 0.15, 2.5));
      globe.pointOfView({ lat: centerLat, lng: centerLng, altitude }, 1000);
    }
  }, [autoRotate, hasData, points, arcs]);

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

  const arcsData = arcs.map((a, i) => ({
    startLat: a.start_lat,
    startLng: a.start_lng,
    endLat: a.end_lat,
    endLng: a.end_lng,
    label: a.label ?? "",
    color: a.color ? resolveColor(a.color) : chartColors[i % chartColors.length],
  }));

  // Compute geographic span for parametric arc/point sizing
  const geoSpan = useMemo(() => {
    const allLats: number[] = [];
    const allLngs: number[] = [];
    for (const p of points) {
      allLats.push(p.lat);
      allLngs.push(p.lng);
    }
    for (const a of arcs) {
      allLats.push(a.start_lat, a.end_lat);
      allLngs.push(a.start_lng, a.end_lng);
    }
    if (allLats.length === 0) return 180; // full globe
    const latSpan = Math.max(...allLats) - Math.min(...allLats);
    const lngSpan = Math.max(...allLngs) - Math.min(...allLngs);
    return Math.max(latSpan, lngSpan, 0.01);
  }, [points, arcs]);

  // Parametric: local data (small span) → thin arcs, low altitude;
  // global data (large span) → thicker arcs, higher altitude
  const isLocal = geoSpan < 5;
  const arcStrokeWidth = isLocal ? 0.5 : geoSpan < 20 ? 0.5 : 0.5;
  const arcAltScale = isLocal ? 0.02 : geoSpan < 20 ? 0.15 : 0.25;
  const pointAlt = isLocal ? 0.002 : 0.01;
  const pointRadiusScale = isLocal ? 0.03 : geoSpan < 20 ? 0.1 : 0.2;
  // For local data, use minimal globe style (no blurry raster zoom)
  const effectiveStyle = isLocal ? "minimal" : style;

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
        className="relative overflow-hidden rounded-lg border border-border-default"
        style={{ height }}
      >
        {!hasData ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-t-tertiary">
            {props.points || props.arcs ? "Loading globe..." : "No geographic data to display"}
          </div>
        ) : containerWidth > 0 ? (
          <Globe
            ref={globeEl}
            width={containerWidth}
            height={height}
            globeImageUrl={GLOBE_IMAGES[effectiveStyle]}
            backgroundColor={dark ? "#111827" : "#f9fafb"}
            pointsData={pointsData}
            pointLat="lat"
            pointLng="lng"
            pointLabel="label"
            pointColor="color"
            pointRadius={pointRadiusScale}
            pointAltitude={pointAlt}
            arcsData={arcsData}
            arcStartLat="startLat"
            arcStartLng="startLng"
            arcEndLat="endLat"
            arcEndLng="endLng"
            arcLabel="label"
            arcColor="color"
            arcStroke={arcStrokeWidth}
            arcAltitudeAutoScale={arcAltScale}
            arcDashLength={isLocal ? 1 : 0.6}
            arcDashGap={isLocal ? 0 : 0.3}
            arcDashAnimateTime={isLocal ? 0 : 2000}
          />
        ) : null}
      </div>
    </div>
  );
}

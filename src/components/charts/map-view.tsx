"use client";

import { useState, useMemo } from "react";
import { Map, Marker, Overlay, GeoJson } from "pigeon-maps";
import { resolveColor, useChartColors } from "@/lib/chart-theme";

interface MarkerItem {
  lat: number;
  lng: number;
  label?: string | null;
  color?: string | null;
}

interface GeoJsonStyle {
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number | null;
  fillOpacity?: number | null;
}

interface MapViewProps {
  title?: string | null;
  markers?: MarkerItem[] | null;
  geojson?: Record<string, unknown> | null;
  geojson_style?: GeoJsonStyle | null;
  center?: [number, number] | null;
  zoom?: number | null;
  height?: number | null;
  /** Feature property name to color by for choropleth maps */
  color_key?: string | null;
  /** Gradient endpoints [low_color, high_color] for choropleth */
  color_scale?: [string, string] | null;
}

interface EventHandle {
  emit: () => void;
  bound: boolean;
  shouldPreventDefault: boolean;
}

function computeBounds(
  markers: MarkerItem[] | null | undefined,
  geojson: Record<string, unknown> | null | undefined
): { center: [number, number]; zoom: number } {
  const lats: number[] = [];
  const lngs: number[] = [];

  if (markers) {
    for (const m of markers) {
      if (typeof m.lat === "number" && typeof m.lng === "number") {
        lats.push(m.lat);
        lngs.push(m.lng);
      }
    }
  }

  if (geojson) {
    const collectCoords = (obj: unknown): void => {
      if (Array.isArray(obj)) {
        if (obj.length >= 2 && typeof obj[0] === "number" && typeof obj[1] === "number") {
          // GeoJSON coordinates are [lng, lat]
          lngs.push(obj[0] as number);
          lats.push(obj[1] as number);
        } else {
          for (const item of obj) collectCoords(item);
        }
      } else if (obj && typeof obj === "object") {
        const rec = obj as Record<string, unknown>;
        if (rec.coordinates) collectCoords(rec.coordinates);
        if (rec.geometry) collectCoords(rec.geometry);
        if (Array.isArray(rec.features)) {
          for (const f of rec.features) collectCoords(f);
        }
        if (Array.isArray(rec.geometries)) {
          for (const g of rec.geometries) collectCoords(g);
        }
      }
    };
    collectCoords(geojson);
  }

  if (lats.length === 0) {
    return { center: [0, 0], zoom: 2 };
  }

  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;

  const latSpan = maxLat - minLat || 0.01;
  const lngSpan = maxLng - minLng || 0.01;
  const zoom = Math.floor(Math.log2(360 / Math.max(lngSpan, latSpan * 1.5)));
  const clampedZoom = Math.max(1, Math.min(18, zoom));

  return { center: [centerLat, centerLng], zoom: clampedZoom };
}

/** Parse a hex color (#rrggbb or #rgb) to [r, g, b] */
function parseHex(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Linearly interpolate between two hex colors at t ∈ [0, 1] */
function lerpColor(c1: [number, number, number], c2: [number, number, number], t: number): string {
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `rgb(${r},${g},${b})`;
}

/** Darken an rgb(...) color by 30% for stroke */
function darkenRgb(rgb: string): string {
  const match = rgb.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!match) return rgb;
  const r = Math.round(Number(match[1]) * 0.7);
  const g = Math.round(Number(match[2]) * 0.7);
  const b = Math.round(Number(match[3]) * 0.7);
  return `rgb(${r},${g},${b})`;
}

export function MapViewComponent({
  props,
  emit,
  on,
}: {
  props: MapViewProps;
  emit?: (event: string) => void;
  on?: (event: string) => EventHandle;
}) {
  const clickHandle = on?.("click");
  const isDrillable = clickHandle?.bound ?? false;
  const chartColors = useChartColors();

  const [hoveredMarker, setHoveredMarker] = useState<number | null>(null);

  const markers = Array.isArray(props.markers) ? props.markers : [];
  const height = props.height ?? 400;

  const bounds = useMemo(
    () => computeBounds(props.markers, props.geojson),
    [props.markers, props.geojson]
  );

  // Pre-compute min/max for choropleth color_key
  const colorRange = useMemo(() => {
    if (!props.color_key || !props.geojson) return null;
    const features = (props.geojson as { features?: unknown[] })?.features;
    if (!Array.isArray(features)) return null;

    let min = Infinity;
    let max = -Infinity;
    for (const f of features) {
      const feat = f as { properties?: Record<string, unknown> };
      const val = Number(feat?.properties?.[props.color_key!]);
      if (!isNaN(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (!isFinite(min) || !isFinite(max)) return null;
    const scale = props.color_scale ?? ["#fee0d2", "#de2d26"];
    return { min, max, low: parseHex(scale[0]), high: parseHex(scale[1]) };
  }, [props.color_key, props.geojson, props.color_scale]);

  const center: [number, number] = props.center ?? bounds.center;
  const zoom = props.zoom ?? bounds.zoom;

  const hasData = markers.length > 0 || props.geojson;
  if (!hasData) {
    return <div style={{ height }} />;
  }

  return (
    <div
      className={`w-full${isDrillable ? " cursor-pointer" : ""}`}
      onClick={isDrillable ? () => emit?.("click") : undefined}
    >
      {props.title && (
        <h3
          className="mb-2 text-t-secondary"
          style={{ fontSize: "var(--chart-title-size)", fontWeight: "var(--chart-title-weight)" }}
        >
          {props.title}
          {isDrillable && (
            <span className="ml-2 text-xs font-normal text-accent">Click to drill down</span>
          )}
        </h3>
      )}
      <div className="overflow-hidden rounded-lg border border-border-default" style={{ height }}>
        <Map defaultCenter={center} defaultZoom={zoom} height={height}>
          {props.geojson && (
            <GeoJson
              data={props.geojson}
              styleCallback={(feature: { properties?: Record<string, unknown> } | undefined) => {
                // Choropleth mode: color features by a numeric property
                if (colorRange && props.color_key && feature?.properties) {
                  const val = Number(feature.properties[props.color_key]);
                  if (!isNaN(val)) {
                    const span = colorRange.max - colorRange.min;
                    const t = span > 0 ? (val - colorRange.min) / span : 0.5;
                    const fill = lerpColor(colorRange.low, colorRange.high, t);
                    return {
                      fill,
                      stroke: darkenRgb(fill),
                      strokeWidth: 1,
                      fillOpacity: 0.7,
                    };
                  }
                  // color_key set but value missing for this feature — gray fallback
                  return {
                    fill: "#9ca3af",
                    stroke: "#6b7280",
                    strokeWidth: 1,
                    fillOpacity: 0.3,
                  };
                }
                // Default uniform styling
                return {
                  fill: props.geojson_style?.fill ?? chartColors[0],
                  stroke: props.geojson_style?.stroke ?? chartColors[0],
                  strokeWidth: props.geojson_style?.strokeWidth ?? 2,
                  fillOpacity: props.geojson_style?.fillOpacity ?? 0.5,
                };
              }}
            />
          )}

          {markers.map((m, i) => {
            const color = m.color ? resolveColor(m.color) : chartColors[i % chartColors.length];

            return (
              <Marker
                key={i}
                anchor={[m.lat, m.lng]}
                color={color}
                width={36}
                onMouseOver={() => setHoveredMarker(i)}
                onMouseOut={() => setHoveredMarker(null)}
              />
            );
          })}

          {hoveredMarker !== null && markers[hoveredMarker]?.label && (
            <Overlay
              anchor={[markers[hoveredMarker].lat, markers[hoveredMarker].lng]}
              offset={[0, -40]}
            >
              <div className="pointer-events-none rounded bg-surface-1 border border-border-default px-2 py-1 text-xs text-t-primary shadow-lg">
                {markers[hoveredMarker].label}
              </div>
            </Overlay>
          )}
        </Map>
      </div>
    </div>
  );
}

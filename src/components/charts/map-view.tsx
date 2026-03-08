"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
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

/** Compute the centroid (center of bounding box) of a GeoJSON feature's geometry */
function computeCentroid(geometry: Record<string, unknown>): [number, number] {
  const lats: number[] = [];
  const lngs: number[] = [];
  const collectCoords = (obj: unknown): void => {
    if (Array.isArray(obj)) {
      if (obj.length >= 2 && typeof obj[0] === "number" && typeof obj[1] === "number") {
        lngs.push(obj[0] as number);
        lats.push(obj[1] as number);
      } else {
        for (const item of obj) collectCoords(item);
      }
    }
  };
  collectCoords(geometry.coordinates);
  if (lats.length === 0) return [0, 0];
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  return [(minLat + maxLat) / 2, (minLng + maxLng) / 2];
}

/** Format a property key for display: snake_case → Title Case */
function formatPropertyKey(key: string): string {
  return key.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a property value for display */
function formatPropertyValue(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString();
  if (value == null) return "—";
  return String(value);
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
  const [selectedFeature, setSelectedFeature] = useState<{
    properties: Record<string, unknown>;
    anchor: [number, number];
  } | null>(null);

  const handleGeoJsonClick = useCallback(
    ({ event, payload }: { event: unknown; payload: unknown }) => {
      // Stop propagation so the map background click doesn't dismiss immediately
      if (event && typeof event === "object" && "stopPropagation" in event) {
        (event as Event).stopPropagation();
      }
      const feature = payload as {
        geometry?: Record<string, unknown>;
        properties?: Record<string, unknown>;
      };
      if (!feature?.geometry) return;
      const anchor = computeCentroid(feature.geometry);
      const properties = (feature.properties ?? {}) as Record<string, unknown>;

      // Toggle: clicking same feature dismisses
      setSelectedFeature((prev) => {
        if (prev && prev.anchor[0] === anchor[0] && prev.anchor[1] === anchor[1]) return null;
        return { properties, anchor };
      });
    },
    []
  );

  // Ref to block native wheel/touch events from reaching the map
  const popoverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const stopWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    const stopTouch = (e: TouchEvent) => {
      e.stopPropagation();
    };
    el.addEventListener("wheel", stopWheel, { passive: false });
    el.addEventListener("touchstart", stopTouch, { passive: false });
    el.addEventListener("touchmove", stopTouch, { passive: false });
    return () => {
      el.removeEventListener("wheel", stopWheel);
      el.removeEventListener("touchstart", stopTouch);
      el.removeEventListener("touchmove", stopTouch);
    };
  }, [selectedFeature]);

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
    if (!Array.isArray(features) || features.length === 0) return null;

    // Resolve the actual property key: try exact match, then case-insensitive
    const resolveKey = (): string | null => {
      const first = features[0] as { properties?: Record<string, unknown> };
      const propKeys = Object.keys(first?.properties ?? {});
      if (propKeys.includes(props.color_key!)) return props.color_key!;
      const lower = props.color_key!.toLowerCase();
      const match = propKeys.find((k) => k.toLowerCase() === lower);
      if (match) return match;
      // Fallback: find first numeric property with variance
      for (const k of propKeys) {
        if (k.startsWith("_")) continue; // skip internal keys
        const vals = features.map((f) =>
          Number((f as { properties?: Record<string, unknown> })?.properties?.[k])
        );
        const numeric = vals.filter((v) => !isNaN(v));
        if (numeric.length === features.length && new Set(numeric).size > 1) return k;
      }
      return null;
    };
    const resolvedKey = resolveKey();
    if (!resolvedKey) return null;

    let min = Infinity;
    let max = -Infinity;
    for (const f of features) {
      const feat = f as { properties?: Record<string, unknown> };
      const val = Number(feat?.properties?.[resolvedKey]);
      if (!isNaN(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (!isFinite(min) || !isFinite(max)) return null;
    const scale = props.color_scale ?? ["#fee0d2", "#de2d26"];
    return { min, max, key: resolvedKey, low: parseHex(scale[0]), high: parseHex(scale[1]) };
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
        <Map
          defaultCenter={center}
          defaultZoom={zoom}
          height={height}
          onClick={() => setSelectedFeature(null)}
        >
          {props.geojson && (
            <GeoJson
              data={props.geojson}
              onClick={handleGeoJsonClick}
              styleCallback={(
                feature: { properties?: Record<string, unknown> } | undefined,
                hover: boolean
              ) => {
                const hoverBoost = hover ? 0.25 : 0;
                // Choropleth mode: color features by a numeric property
                if (colorRange && feature?.properties) {
                  const val = Number(feature.properties[colorRange.key]);
                  if (!isNaN(val)) {
                    const span = colorRange.max - colorRange.min;
                    const t = span > 0 ? (val - colorRange.min) / span : 0.5;
                    const fill = lerpColor(colorRange.low, colorRange.high, t);
                    return {
                      fill,
                      stroke: darkenRgb(fill),
                      strokeWidth: hover ? 2 : 1,
                      fillOpacity: Math.min(1, 0.7 + hoverBoost),
                      cursor: "pointer",
                    };
                  }
                  // color_key set but value missing for this feature — gray fallback
                  return {
                    fill: "#9ca3af",
                    stroke: "#6b7280",
                    strokeWidth: 1,
                    fillOpacity: 0.3,
                    cursor: "pointer",
                  };
                }
                // Default uniform styling
                return {
                  fill: props.geojson_style?.fill ?? chartColors[0],
                  stroke: props.geojson_style?.stroke ?? chartColors[0],
                  strokeWidth: hover
                    ? (props.geojson_style?.strokeWidth ?? 2) + 1
                    : (props.geojson_style?.strokeWidth ?? 2),
                  fillOpacity: Math.min(1, (props.geojson_style?.fillOpacity ?? 0.5) + hoverBoost),
                  cursor: "pointer",
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

          {selectedFeature && (
            <Overlay anchor={selectedFeature.anchor} offset={[0, -10]}>
              <div
                ref={popoverRef}
                className="rounded-lg bg-surface-1 border border-border-default shadow-xl text-xs text-t-primary"
                style={{ minWidth: 180, maxWidth: 280, maxHeight: 240, overflow: "auto" }}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between sticky top-0 bg-surface-1 px-3 py-2 border-b border-border-default">
                  <span className="font-semibold text-sm">Feature Properties</span>
                  <button
                    className="text-t-secondary hover:text-t-primary ml-2 text-base leading-none"
                    onClick={() => setSelectedFeature(null)}
                  >
                    ×
                  </button>
                </div>
                <div className="px-3 py-2">
                  {Object.entries(selectedFeature.properties).length === 0 ? (
                    <span className="text-t-secondary italic">No properties</span>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {Object.entries(selectedFeature.properties).map(([key, value]) => (
                          <tr key={key} className="border-b border-border-default last:border-0">
                            <td className="pr-2 py-1 text-t-secondary font-medium whitespace-nowrap align-top">
                              {formatPropertyKey(key)}
                            </td>
                            <td className="py-1 text-right align-top">
                              {formatPropertyValue(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </Overlay>
          )}
        </Map>
      </div>
    </div>
  );
}

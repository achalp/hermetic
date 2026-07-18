"use client";

// Must be imported before any @deck.gl/* to force WebGL2
import "@/lib/deckgl-init";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { WebMercatorViewport } from "@deck.gl/core";
import { ScatterplotLayer, ArcLayer, ColumnLayer } from "@deck.gl/layers";
import { HexagonLayer, HeatmapLayer } from "@deck.gl/aggregation-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer } from "@deck.gl/layers";
import { resolveColor, useChartColors } from "@/lib/chart-theme";
import { BASEMAP_TILES, rampColor, numericRange } from "@/components/charts/map-color-ramp";

interface Map3DInnerProps {
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
  /** Basemap theme. Defaults to "light" (clean light-grey; points carry the color). */
  basemap?: "dark" | "light" | null;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

/** Format a property key for display: snake_case → Title Case */
function formatKey(key: string): string {
  return key.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Format a property value for display */
function formatVal(value: unknown): string {
  if (typeof value === "number") return value.toLocaleString();
  if (value == null) return "—";
  return String(value);
}

interface PickedFeature {
  x: number;
  y: number;
  properties: Record<string, unknown>;
}

export function Map3DInner(props: Map3DInnerProps) {
  const [ready, setReady] = useState(false);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [hoverInfo, setHoverInfo] = useState<PickedFeature | null>(null);
  const [clickInfo, setClickInfo] = useState<PickedFeature | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartColors = useChartColors();

  // Only mount DeckGL once the container actually has a non-zero size. Creating
  // the WebGL device on a 0x0 canvas triggers the luma.gl race where
  // device.limits is undefined ("maxTextureDimension2D"). A ResizeObserver waits
  // for real dimensions (e.g. a collapsed flex cell that lays out a frame later).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const check = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setReady(true);
        // Feed real dimensions to fitBounds so the initial view frames all points.
        setSize((prev) =>
          prev && prev.width === el.clientWidth && prev.height === el.clientHeight
            ? prev
            : { width: el.clientWidth, height: el.clientHeight }
        );
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleError = useCallback((error: Error) => {
    // Suppress the luma.gl maxTextureDimension2D race condition error
    if (error?.message?.includes("maxTextureDimension2D")) return;
    console.error("DeckGL error:", error);
  }, []);
  const {
    data,
    lat_key,
    lng_key,
    layer_type,
    value_key,
    target_lat_key,
    target_lng_key,
    color_key,
    color_map,
    elevation_scale = 1,
    radius = 1000,
    opacity = 0.8,
    pitch = 45,
    bearing = 0,
    height = 500,
    basemap = "light",
  } = props;

  // Numeric range of value_key, for the color ramp (points shaded by metric).
  const valueRange = useMemo(() => numericRange(data, value_key), [data, value_key]);

  // Frame the data on first render: fit ALL points into the viewport (with the
  // most-isolated/highest-ranked ones therefore always visible) rather than
  // centering on the raw centroid at a fixed zoom — the old approach drifted
  // off-target and cropped points whenever they spanned a wide area.
  const viewState = useMemo(() => {
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;
    for (const row of data) {
      const lat = Number(row[lat_key]);
      const lng = Number(row[lng_key]);
      if (!isNaN(lat) && !isNaN(lng)) {
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        minLng = Math.min(minLng, lng);
        maxLng = Math.max(maxLng, lng);
        sumLat += lat;
        sumLng += lng;
        count++;
      }
    }
    const base = { pitch: pitch ?? 45, bearing: bearing ?? 0 };
    if (count === 0) return { latitude: 0, longitude: 0, zoom: 1, ...base };

    const centerLng = sumLng / count;
    const centerLat = sumLat / count;
    // A single point (or all-coincident points) has no extent to fit — center
    // on it at a sensible neighborhood zoom.
    const negligibleSpan = maxLat - minLat < 1e-6 && maxLng - minLng < 1e-6;
    if (!size || negligibleSpan) {
      return { latitude: centerLat, longitude: centerLng, zoom: negligibleSpan ? 12 : 10, ...base };
    }
    try {
      const fitted = new WebMercatorViewport({
        width: size.width,
        height: size.height,
      }).fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 48 }
      );
      // Cap zoom so a tight cluster doesn't slam to street level.
      return {
        latitude: fitted.latitude,
        longitude: fitted.longitude,
        zoom: Math.min(fitted.zoom, 14),
        ...base,
      };
    } catch {
      return { latitude: centerLat, longitude: centerLng, zoom: 10, ...base };
    }
  }, [data, lat_key, lng_key, pitch, bearing, size]);

  // Base map tile layer — dark (default) or light Carto basemap.
  const tileLayer = new TileLayer({
    id: "basemap-tiles",
    data: BASEMAP_TILES[basemap ?? "light"],
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (tileProps: Record<string, unknown>) => {
      const { boundingBox } = tileProps.tile as {
        boundingBox: [[number, number], [number, number]];
      };
      return new BitmapLayer({
        ...tileProps,
        data: undefined,
        image: tileProps.data as string,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]],
      });
    },
  });

  const dataLayer = useMemo(() => {
    const getPosition = (d: Record<string, unknown>): [number, number] => [
      Number(d[lng_key]),
      Number(d[lat_key]),
    ];

    const getColor = (d: Record<string, unknown>): [number, number, number] => {
      // Shade by the numeric value_key via the plasma ramp when available — a
      // metric heat gradient reads far better than a flat single color.
      if (valueRange && value_key) {
        const n = Number(d[value_key]);
        if (isFinite(n)) return rampColor((n - valueRange.min) / (valueRange.max - valueRange.min));
      }
      if (color_key && color_map && d[color_key]) {
        const name = String(d[color_key]);
        const resolved = color_map[name] ? resolveColor(color_map[name]) : chartColors[0];
        return hexToRgb(resolved);
      }
      return hexToRgb(chartColors[0]);
    };

    switch (layer_type) {
      case "hexagon":
        return new HexagonLayer({
          id: "hexagon-layer",
          data,
          getPosition,
          pickable: true,
          gpuAggregation: false,
          extruded: true,
          radius: radius ?? 1000,
          elevationScale: elevation_scale ?? 4,
          opacity: opacity ?? 0.8,
          colorRange: chartColors
            .slice(0, 6)
            .map(hexToRgb)
            .map((c) => [...c, 255] as [number, number, number, number]),
        });

      case "column":
        return new ColumnLayer({
          id: "column-layer",
          data,
          getPosition,
          pickable: true,
          getElevation: (d: Record<string, unknown>) =>
            value_key ? Number(d[value_key]) || 0 : 100,
          getFillColor: (d: Record<string, unknown>) =>
            [...getColor(d), 200] as [number, number, number, number],
          diskResolution: 12,
          radius: radius ?? 200,
          extruded: true,
          elevationScale: elevation_scale ?? 1,
          opacity: opacity ?? 0.8,
        });

      case "arc":
        return new ArcLayer({
          id: "arc-layer",
          data,
          getSourcePosition: getPosition,
          getTargetPosition: (d: Record<string, unknown>): [number, number] => [
            Number(d[target_lng_key ?? lng_key]),
            Number(d[target_lat_key ?? lat_key]),
          ],
          getSourceColor: () => hexToRgb(chartColors[0]),
          getTargetColor: () => hexToRgb(chartColors[1]),
          getWidth: 2,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 80],
          opacity: opacity ?? 0.8,
        });

      case "scatterplot": {
        // Size dots by the metric so rank/isolation reads at a glance: normalize
        // value_key across the dataset to a PIXEL radius. (The old code used the
        // raw value as a radius in METERS, so km-scale values like 15 became
        // ~15m — far below radiusMinPixels — and every dot collapsed to the same
        // 3px floor, losing all rank information.)
        const R_MIN_PX = 6;
        const R_MAX_PX = 22;
        return new ScatterplotLayer({
          id: "scatterplot-layer",
          data,
          getPosition,
          pickable: true,
          getFillColor: (d: Record<string, unknown>) =>
            [...getColor(d), 230] as [number, number, number, number],
          getRadius: (d: Record<string, unknown>) => {
            if (valueRange && value_key && valueRange.max > valueRange.min) {
              const n = Number(d[value_key]);
              if (isFinite(n)) {
                const t = (n - valueRange.min) / (valueRange.max - valueRange.min);
                return R_MIN_PX + t * (R_MAX_PX - R_MIN_PX);
              }
            }
            return radius ?? R_MIN_PX;
          },
          radiusUnits: "pixels",
          radiusScale: 1,
          radiusMinPixels: 3,
          radiusMaxPixels: 40,
          // Thin dark outline so the colored dots stay crisp on a light basemap.
          stroked: true,
          getLineColor: [40, 40, 40, 90],
          lineWidthMinPixels: 0.5,
          opacity: opacity ?? 0.9,
        });
      }

      case "heatmap":
        return new HeatmapLayer({
          id: "heatmap-layer",
          data,
          getPosition,
          pickable: true,
          getWeight: (d: Record<string, unknown>) => (value_key ? Number(d[value_key]) || 1 : 1),
          gpuAggregation: false,
          radiusPixels: radius ? Math.min(radius, 100) : 30,
          intensity: 1,
          threshold: 0.05,
          opacity: opacity ?? 0.8,
        });
    }
  }, [
    data,
    lat_key,
    lng_key,
    layer_type,
    value_key,
    target_lat_key,
    target_lng_key,
    color_key,
    color_map,
    elevation_scale,
    radius,
    opacity,
    chartColors,
    valueRange,
  ]);

  const extractProperties = useCallback(
    (info: { object?: unknown }): Record<string, unknown> | null => {
      const obj = info.object;
      if (!obj || typeof obj !== "object") return null;
      const rec = obj as Record<string, unknown>;
      // For aggregation layers (hexagon), show aggregated stats
      if (Array.isArray(rec.points)) {
        return {
          Count: rec.points.length,
          ...(rec.elevationValue != null ? { Value: rec.elevationValue } : {}),
        };
      }
      // For regular layers, show all non-internal properties
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === "function" || typeof v === "object") continue;
        result[k] = v;
      }
      return Object.keys(result).length > 0 ? result : null;
    },
    []
  );

  const onHover = useCallback(
    (info: { object?: unknown; x: number; y: number }) => {
      if (!info.object) {
        setHoverInfo(null);
        return;
      }
      const properties = extractProperties(info);
      if (properties) {
        setHoverInfo({ x: info.x, y: info.y, properties });
      }
    },
    [extractProperties]
  );

  const onDeckClick = useCallback(
    (info: { object?: unknown; x: number; y: number }) => {
      if (!info.object) {
        setClickInfo(null);
        return;
      }
      const properties = extractProperties(info);
      if (properties) {
        setClickInfo({ x: info.x, y: info.y, properties });
      }
    },
    [extractProperties]
  );

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%", height: height ?? 500 }}>
      {ready && (
        <DeckGL
          initialViewState={viewState}
          controller
          layers={[tileLayer, dataLayer]}
          onError={handleError}
          onHover={onHover}
          onClick={onDeckClick}
          getCursor={({ isHovering }: { isHovering: boolean }) => (isHovering ? "pointer" : "grab")}
        />
      )}
      {/* Hover tooltip */}
      {hoverInfo && !clickInfo && (
        <div
          style={{
            position: "absolute",
            left: hoverInfo.x + 12,
            top: hoverInfo.y + 12,
            pointerEvents: "none",
            zIndex: 10,
            maxWidth: 260,
          }}
          className="rounded bg-surface-1 border border-border-default px-2 py-1.5 text-xs text-t-primary shadow-lg"
        >
          {Object.entries(hoverInfo.properties).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <span className="text-t-secondary font-medium">{formatKey(k)}</span>
              <span>{formatVal(v)}</span>
            </div>
          ))}
        </div>
      )}
      {/* Click popup */}
      {clickInfo && (
        <div
          ref={popoverRef}
          style={{
            position: "absolute",
            left: Math.min(
              clickInfo.x,
              (typeof window !== "undefined" ? window.innerWidth : 800) - 300
            ),
            top: clickInfo.y,
            zIndex: 20,
            minWidth: 180,
            maxWidth: 280,
            maxHeight: 240,
            overflow: "auto",
          }}
          className="rounded-lg bg-surface-1 border border-border-default shadow-xl text-xs text-t-primary"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between sticky top-0 bg-surface-1 px-3 py-2 border-b border-border-default">
            <span className="font-semibold text-sm">Properties</span>
            <button
              className="text-t-secondary hover:text-t-primary ml-2 text-base leading-none"
              onClick={() => setClickInfo(null)}
            >
              ×
            </button>
          </div>
          <div className="px-3 py-2">
            <table className="w-full">
              <tbody>
                {Object.entries(clickInfo.properties).map(([k, v]) => (
                  <tr key={k} className="border-b border-border-default last:border-0">
                    <td className="pr-2 py-1 text-t-secondary font-medium whitespace-nowrap align-top">
                      {formatKey(k)}
                    </td>
                    <td className="py-1 text-right align-top">{formatVal(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

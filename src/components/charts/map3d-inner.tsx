"use client";

// Must be imported before any @deck.gl/* to force WebGL2
import "@/lib/deckgl-init";

import { useMemo, useState, useEffect, useCallback, useRef } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, ArcLayer, ColumnLayer } from "@deck.gl/layers";
import { HexagonLayer, HeatmapLayer } from "@deck.gl/aggregation-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer } from "@deck.gl/layers";
import { resolveColor, useChartColors } from "@/lib/chart-theme";

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
  const [hoverInfo, setHoverInfo] = useState<PickedFeature | null>(null);
  const [clickInfo, setClickInfo] = useState<PickedFeature | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const chartColors = useChartColors();

  // Delay mount to let the container get a stable size before DeckGL creates its canvas.
  // This avoids the luma.gl ResizeObserver race where device.limits is undefined.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
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
  } = props;

  // Compute center from data
  const viewState = useMemo(() => {
    let sumLat = 0;
    let sumLng = 0;
    let count = 0;
    for (const row of data) {
      const lat = Number(row[lat_key]);
      const lng = Number(row[lng_key]);
      if (!isNaN(lat) && !isNaN(lng)) {
        sumLat += lat;
        sumLng += lng;
        count++;
      }
    }
    return {
      latitude: count > 0 ? sumLat / count : 0,
      longitude: count > 0 ? sumLng / count : 0,
      zoom: 10,
      pitch: pitch ?? 45,
      bearing: bearing ?? 0,
    };
  }, [data, lat_key, lng_key, pitch, bearing]);

  // Base map tile layer (OSM)
  const tileLayer = new TileLayer({
    id: "osm-tiles",
    data: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
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

      case "scatterplot":
        return new ScatterplotLayer({
          id: "scatterplot-layer",
          data,
          getPosition,
          pickable: true,
          getFillColor: (d: Record<string, unknown>) =>
            [...getColor(d), 200] as [number, number, number, number],
          getRadius: (d: Record<string, unknown>) =>
            value_key ? Math.max(50, Number(d[value_key]) || 100) : (radius ?? 100),
          radiusScale: 1,
          radiusMinPixels: 2,
          radiusMaxPixels: 50,
          opacity: opacity ?? 0.8,
        });

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

  if (!ready) {
    return <div style={{ width: "100%", height: height ?? 500 }} />;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: height ?? 500 }}>
      <DeckGL
        initialViewState={viewState}
        controller
        layers={[tileLayer, dataLayer]}
        onError={handleError}
        onHover={onHover}
        onClick={onDeckClick}
        getCursor={({ isHovering }: { isHovering: boolean }) => (isHovering ? "pointer" : "grab")}
      />
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

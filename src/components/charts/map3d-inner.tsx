"use client";

import { useMemo } from "react";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, ArcLayer, ColumnLayer } from "@deck.gl/layers";
import { HexagonLayer, HeatmapLayer } from "@deck.gl/aggregation-layers";
import { TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer } from "@deck.gl/layers";
import { resolveColor, useChartColors } from "@/lib/chart-theme";

// Force deck.gl v9 to use WebGL2 instead of WebGPU
luma.registerAdapters([webgl2Adapter]);

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

export function Map3DInner(props: Map3DInnerProps) {
  const chartColors = useChartColors();
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
          gpuAggregation: false, // WebGL2 doesn't support GPU aggregation
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
          opacity: opacity ?? 0.8,
        });

      case "scatterplot":
        return new ScatterplotLayer({
          id: "scatterplot-layer",
          data,
          getPosition,
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

  return (
    <div style={{ position: "relative", width: "100%", height: height ?? 500 }}>
      <DeckGL initialViewState={viewState} controller layers={[tileLayer, dataLayer]} />
    </div>
  );
}

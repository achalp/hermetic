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
              styleCallback={() => ({
                fill: props.geojson_style?.fill ?? chartColors[0] + "4D",
                stroke: props.geojson_style?.stroke ?? chartColors[0],
                strokeWidth: props.geojson_style?.strokeWidth ?? 2,
                fillOpacity: props.geojson_style?.fillOpacity ?? 0.3,
              })}
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

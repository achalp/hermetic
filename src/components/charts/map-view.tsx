"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import MapGL, {
  Source,
  Layer,
  Marker,
  Popup,
  type MapRef,
  type MapLayerMouseEvent,
} from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
/* eslint-disable @typescript-eslint/no-explicit-any */
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

const BASEMAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

function computeBounds(
  markers: MarkerItem[] | null | undefined,
  geojson: Record<string, unknown> | null | undefined
): { center: [number, number]; zoom: number; bbox: [[number, number], [number, number]] | null } {
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
    return { center: [0, 0], zoom: 2, bbox: null };
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

  // bbox as [[sw_lng, sw_lat], [ne_lng, ne_lat]] for MapLibre fitBounds
  const bbox: [[number, number], [number, number]] = [
    [minLng, minLat],
    [maxLng, maxLat],
  ];

  return { center: [centerLat, centerLng], zoom: clampedZoom, bbox };
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

/** Darken a hex color by 30% */
function darkenHex(hex: string): string {
  const [r, g, b] = parseHex(hex);
  const dr = Math.round(r * 0.7);
  const dg = Math.round(g * 0.7);
  const db = Math.round(b * 0.7);
  return `#${dr.toString(16).padStart(2, "0")}${dg.toString(16).padStart(2, "0")}${db.toString(16).padStart(2, "0")}`;
}

/** Simple SVG map pin */
function PinMarker({ color, size = 28 }: { color: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size * 1.4}
      viewBox="0 0 24 34"
      style={{ transform: "translate(-50%, -100%)", cursor: "pointer" }}
    >
      <path
        d="M12 0C5.4 0 0 5.4 0 12c0 9 12 22 12 22s12-13 12-22C24 5.4 18.6 0 12 0z"
        fill={color}
        stroke="white"
        strokeWidth="1.5"
      />
      <circle cx="12" cy="12" r="4.5" fill="white" />
    </svg>
  );
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
  const mapRef = useRef<MapRef>(null);
  const hoveredFeatureId = useRef<number | null>(null);

  const [hoveredMarker, setHoveredMarker] = useState<number | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<{
    properties: Record<string, unknown>;
    anchor: [number, number]; // [lat, lng]
  } | null>(null);

  const currentMarkers = useMemo(
    () =>
      Array.isArray(props.markers)
        ? props.markers.filter((m) => isFinite(m.lat) && isFinite(m.lng))
        : [],
    [props.markers]
  );
  const height = props.height ?? 400;

  // Cache last-known-good data so the map never unmounts on transient null props.
  // Uses the React-endorsed "adjusting state during render" pattern to avoid
  // effects and refs, which the lint rules prohibit in render context.
  const [cachedGeoJson, setCachedGeoJson] = useState<Record<string, unknown> | null>(
    props.geojson ?? null
  );
  const [cachedMarkers, setCachedMarkers] = useState<MarkerItem[]>(currentMarkers);
  if (props.geojson && props.geojson !== cachedGeoJson) {
    setCachedGeoJson(props.geojson);
  }
  if (currentMarkers.length > 0 && currentMarkers !== cachedMarkers) {
    setCachedMarkers(currentMarkers);
  }

  const markers = currentMarkers.length > 0 ? currentMarkers : cachedMarkers;
  const geojson = props.geojson ?? cachedGeoJson;

  const bounds = useMemo(() => computeBounds(markers, geojson), [markers, geojson]);

  // Pre-compute min/max for choropleth color_key
  const colorRange = useMemo(() => {
    if (!props.color_key || !geojson) return null;
    const features = (geojson as { features?: unknown[] })?.features;
    if (!Array.isArray(features) || features.length === 0) return null;

    const resolveKey = (): string | null => {
      const first = features[0] as { properties?: Record<string, unknown> };
      const propKeys = Object.keys(first?.properties ?? {});
      if (propKeys.includes(props.color_key!)) return props.color_key!;
      const lower = props.color_key!.toLowerCase();
      const match = propKeys.find((k) => k.toLowerCase() === lower);
      if (match) return match;
      for (const k of propKeys) {
        if (k.startsWith("_")) continue;
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
    return { min, max, key: resolvedKey, low: scale[0], high: scale[1] };
  }, [props.color_key, geojson, props.color_scale]);

  const center: [number, number] = props.center ?? bounds.center;
  const zoom = props.zoom ?? bounds.zoom;

  // Fit map to data bounds whenever data changes
  const mapLoaded = useRef(false);
  useEffect(() => {
    if (!mapLoaded.current) return;
    const map = mapRef.current;
    if (!map || !bounds.bbox) return;
    map.fitBounds(bounds.bbox, { padding: 40, duration: 0 });
  }, [bounds]);

  // --- MapLibre layer paint specs ---

  const fillPaint = useMemo(() => {
    if (colorRange) {
      return {
        "fill-color": [
          "interpolate",
          ["linear"],
          ["get", colorRange.key],
          colorRange.min,
          colorRange.low,
          colorRange.max,
          colorRange.high,
        ],
        "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.9, 0.65],
      } as any;
    }
    return {
      "fill-color": props.geojson_style?.fill ?? chartColors[0],
      "fill-opacity": [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        Math.min(1, (props.geojson_style?.fillOpacity ?? 0.5) + 0.25),
        props.geojson_style?.fillOpacity ?? 0.5,
      ],
    } as any;
  }, [colorRange, props.geojson_style, chartColors]);

  const linePaint = useMemo(() => {
    const baseWidth = props.geojson_style?.strokeWidth ?? 2;
    if (colorRange) {
      return {
        "line-color": [
          "case",
          [
            "any",
            ["==", ["geometry-type"], "LineString"],
            ["==", ["geometry-type"], "MultiLineString"],
          ],
          [
            "interpolate",
            ["linear"],
            ["get", colorRange.key],
            colorRange.min,
            colorRange.low,
            colorRange.max,
            colorRange.high,
          ],
          [
            "interpolate",
            ["linear"],
            ["get", colorRange.key],
            colorRange.min,
            darkenHex(colorRange.low),
            colorRange.max,
            darkenHex(colorRange.high),
          ],
        ],
        "line-width": [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          baseWidth + 1,
          baseWidth,
        ],
      } as any;
    }
    return {
      "line-color": props.geojson_style?.stroke ?? props.geojson_style?.fill ?? chartColors[0],
      "line-width": [
        "case",
        ["boolean", ["feature-state", "hover"], false],
        baseWidth + 1,
        baseWidth,
      ],
    } as any;
  }, [colorRange, props.geojson_style, chartColors]);

  const circlePaint = useMemo(() => {
    if (colorRange) {
      return {
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", colorRange.key],
          colorRange.min,
          colorRange.low,
          colorRange.max,
          colorRange.high,
        ],
        "circle-radius": ["case", ["boolean", ["feature-state", "hover"], false], 7, 5],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 1.5,
        "circle-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0.8],
      } as any;
    }
    return {
      "circle-color": props.geojson_style?.fill ?? chartColors[0],
      "circle-radius": ["case", ["boolean", ["feature-state", "hover"], false], 7, 5],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1.5,
      "circle-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 1, 0.8],
    } as any;
  }, [colorRange, props.geojson_style, chartColors]);

  // --- Hover / click handlers ---

  const interactiveLayerIds = useMemo(
    () => (geojson ? ["geojson-fill", "geojson-line", "geojson-line-hit", "geojson-circle"] : []),
    [geojson]
  );

  const onMouseMove = useCallback((e: MapLayerMouseEvent) => {
    const map = mapRef.current?.getMap();
    if (!map) return;

    if (hoveredFeatureId.current !== null) {
      map.setFeatureState({ source: "geojson", id: hoveredFeatureId.current }, { hover: false });
      hoveredFeatureId.current = null;
    }

    if (e.features && e.features.length > 0) {
      const feature = e.features[0];
      hoveredFeatureId.current = feature.id as number;
      map.setFeatureState({ source: "geojson", id: feature.id as number }, { hover: true });
      map.getCanvas().style.cursor = "pointer";
    } else {
      map.getCanvas().style.cursor = "";
    }
  }, []);

  const onMouseOut = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map || hoveredFeatureId.current === null) return;
    map.setFeatureState({ source: "geojson", id: hoveredFeatureId.current }, { hover: false });
    hoveredFeatureId.current = null;
    map.getCanvas().style.cursor = "";
  }, []);

  const onMapClick = useCallback((e: MapLayerMouseEvent) => {
    if (!e.features || e.features.length === 0) {
      setSelectedFeature(null);
      return;
    }
    const feature = e.features[0];
    const geometry = feature.geometry as unknown as Record<string, unknown>;
    const centroid = computeCentroid(geometry);
    const properties = (feature.properties ?? {}) as Record<string, unknown>;

    setSelectedFeature((prev) => {
      if (prev && prev.anchor[0] === centroid[0] && prev.anchor[1] === centroid[1]) return null;
      return { properties, anchor: centroid };
    });
  }, []);

  const hasData = markers.length > 0 || geojson;
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
        <MapGL
          ref={mapRef}
          initialViewState={{
            latitude: isFinite(center[0]) ? center[0] : 0,
            longitude: isFinite(center[1]) ? center[1] : 0,
            zoom: isFinite(zoom) ? zoom : 2,
          }}
          style={{ width: "100%", height: "100%" }}
          mapStyle={BASEMAP_STYLE}
          interactiveLayerIds={interactiveLayerIds}
          onLoad={() => {
            mapLoaded.current = true;
            if (bounds.bbox) {
              mapRef.current?.fitBounds(bounds.bbox, { padding: 40, duration: 0 });
            }
          }}
          onMouseMove={onMouseMove}
          onMouseOut={onMouseOut}
          onClick={onMapClick}
        >
          {geojson && (
            <Source
              id="geojson"
              type="geojson"
              data={geojson as unknown as GeoJSON.FeatureCollection}
              generateId
            >
              <Layer
                id="geojson-fill"
                type="fill"
                filter={
                  [
                    "any",
                    ["==", ["geometry-type"], "Polygon"],
                    ["==", ["geometry-type"], "MultiPolygon"],
                  ] as any
                }
                paint={fillPaint}
              />
              <Layer id="geojson-line" type="line" paint={linePaint} />
              {/* Invisible wide line for easier click/hover targeting */}
              <Layer
                id="geojson-line-hit"
                type="line"
                paint={{ "line-color": "transparent", "line-width": 12 } as any}
              />
              <Layer
                id="geojson-circle"
                type="circle"
                filter={
                  [
                    "any",
                    ["==", ["geometry-type"], "Point"],
                    ["==", ["geometry-type"], "MultiPoint"],
                  ] as any
                }
                paint={circlePaint}
              />
            </Source>
          )}

          {markers.map((m, i) => {
            const color = m.color ? resolveColor(m.color) : chartColors[i % chartColors.length];
            return (
              <Marker key={i} latitude={m.lat} longitude={m.lng} anchor="bottom">
                <div
                  onMouseEnter={() => setHoveredMarker(i)}
                  onMouseLeave={() => setHoveredMarker(null)}
                >
                  <PinMarker color={color} />
                </div>
              </Marker>
            );
          })}

          {hoveredMarker !== null && markers[hoveredMarker]?.label && (
            <Popup
              latitude={markers[hoveredMarker].lat}
              longitude={markers[hoveredMarker].lng}
              offset={[0, -40] as [number, number]}
              closeButton={false}
              closeOnClick={false}
              className="map-marker-tooltip"
            >
              <div className="text-xs text-gray-900">{markers[hoveredMarker].label}</div>
            </Popup>
          )}

          {selectedFeature &&
            isFinite(selectedFeature.anchor[0]) &&
            isFinite(selectedFeature.anchor[1]) && (
              <Popup
                latitude={selectedFeature.anchor[0]}
                longitude={selectedFeature.anchor[1]}
                offset={[0, -10] as [number, number]}
                closeButton={false}
                closeOnClick={false}
                maxWidth="280px"
                className="map-feature-popup"
              >
                <div
                  className="text-xs"
                  style={{ minWidth: 180, maxHeight: 220, overflow: "auto" }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between pb-1 mb-1 border-b border-gray-200">
                    <span className="font-semibold text-sm text-gray-900">Feature Properties</span>
                    <button
                      className="text-gray-400 hover:text-gray-700 ml-2 text-base leading-none"
                      onClick={() => setSelectedFeature(null)}
                    >
                      ×
                    </button>
                  </div>
                  {Object.entries(selectedFeature.properties).length === 0 ? (
                    <span className="text-gray-400 italic">No properties</span>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {Object.entries(selectedFeature.properties).map(([key, value]) => (
                          <tr key={key} className="border-b border-gray-100 last:border-0">
                            <td className="pr-2 py-1 text-gray-500 font-medium whitespace-nowrap align-top">
                              {formatPropertyKey(key)}
                            </td>
                            <td className="py-1 text-right align-top text-gray-900">
                              {formatPropertyValue(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </Popup>
            )}
        </MapGL>
      </div>
    </div>
  );
}

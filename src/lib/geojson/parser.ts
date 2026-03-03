import type { ParsedCSV } from "@/lib/csv/parser";

// ── GeoJSON type helpers (minimal, no external dependency) ────────

interface GeoJSONGeometry {
  type: string;
  coordinates: unknown;
}

interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry | null;
  properties: Record<string, unknown> | null;
}

interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
}

export interface ParsedGeoJSON extends ParsedCSV {
  /** Raw GeoJSON FeatureCollection for map rendering */
  raw: GeoJSONFeatureCollection;
  /** Dominant geometry type across features */
  geometryType: string;
  /** Bounding box [minLng, minLat, maxLng, maxLat] or null if no coordinates */
  bbox: [number, number, number, number] | null;
}

/**
 * Parse a GeoJSON string into tabular form (compatible with ParsedCSV)
 * plus a raw sidecar for map rendering.
 */
export function parseGeoJSON(text: string): ParsedGeoJSON {
  const obj = JSON.parse(text);
  const fc = normalizeToFeatureCollection(obj);

  if (fc.features.length === 0) {
    throw new Error("GeoJSON has no features");
  }

  // Collect all unique property keys across features
  const keySet = new Set<string>();
  for (const f of fc.features) {
    if (f.properties) {
      for (const k of Object.keys(f.properties)) {
        keySet.add(k);
      }
    }
  }

  // Build headers: properties + synthetic columns
  const propKeys = [...keySet];
  const headers = [...propKeys, "_geometry_type"];

  // Determine if any feature is a Point (to add _lat/_lng columns)
  const hasPoints = fc.features.some(
    (f) => f.geometry?.type === "Point" || f.geometry?.type === "MultiPoint"
  );
  const hasNonPoints = fc.features.some(
    (f) => f.geometry && f.geometry.type !== "Point" && f.geometry.type !== "MultiPoint"
  );

  if (hasPoints) {
    headers.push("_lat", "_lng");
  }
  if (hasNonPoints) {
    headers.push("_geometry");
  }

  // Flatten features into rows
  const data: Record<string, string>[] = [];
  const geomTypeCounts: Record<string, number> = {};

  for (const f of fc.features) {
    const row: Record<string, string> = {};

    // Properties
    for (const k of propKeys) {
      const v = f.properties?.[k];
      row[k] = v == null ? "" : String(v);
    }

    // Geometry type
    const gtype = f.geometry?.type ?? "None";
    row["_geometry_type"] = gtype;
    geomTypeCounts[gtype] = (geomTypeCounts[gtype] ?? 0) + 1;

    // Point coordinates → _lat/_lng
    if (hasPoints) {
      if (f.geometry?.type === "Point") {
        const coords = f.geometry.coordinates as number[];
        row["_lng"] = String(coords[0] ?? "");
        row["_lat"] = String(coords[1] ?? "");
      } else {
        row["_lat"] = "";
        row["_lng"] = "";
      }
    }

    // Non-point geometry → _geometry (JSON string)
    if (hasNonPoints) {
      if (f.geometry && f.geometry.type !== "Point" && f.geometry.type !== "MultiPoint") {
        row["_geometry"] = JSON.stringify(f.geometry);
      } else {
        row["_geometry"] = "";
      }
    }

    data.push(row);
  }

  // Dominant geometry type
  const geometryType = Object.entries(geomTypeCounts).sort((a, b) => b[1] - a[1])[0][0];

  // Compute bbox from all coordinates
  const bbox = computeBBox(fc);

  return {
    headers,
    data,
    rowCount: data.length,
    raw: fc,
    geometryType,
    bbox,
  };
}

/**
 * Check if a parsed JSON object looks like GeoJSON.
 */
export function isGeoJSONObject(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  const rec = obj as Record<string, unknown>;
  return (
    rec.type === "FeatureCollection" ||
    rec.type === "Feature" ||
    (typeof rec.type === "string" && typeof rec.coordinates !== "undefined")
  );
}

// ── Internals ─────────────────────────────────────────────────────

function normalizeToFeatureCollection(obj: unknown): GeoJSONFeatureCollection {
  if (!obj || typeof obj !== "object") {
    throw new Error("Invalid GeoJSON: not an object");
  }

  const rec = obj as Record<string, unknown>;

  if (rec.type === "FeatureCollection") {
    const features = Array.isArray(rec.features) ? rec.features : [];
    return {
      type: "FeatureCollection",
      features: features.map(normalizeFeature),
    };
  }

  if (rec.type === "Feature") {
    return {
      type: "FeatureCollection",
      features: [normalizeFeature(rec)],
    };
  }

  // Bare geometry object
  if (typeof rec.type === "string" && rec.coordinates !== undefined) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: rec.type as string, coordinates: rec.coordinates },
          properties: {},
        },
      ],
    };
  }

  throw new Error("Invalid GeoJSON: unrecognized type");
}

function normalizeFeature(obj: unknown): GeoJSONFeature {
  if (!obj || typeof obj !== "object") {
    return { type: "Feature", geometry: null, properties: {} };
  }
  const rec = obj as Record<string, unknown>;
  return {
    type: "Feature",
    geometry: (rec.geometry as GeoJSONGeometry) ?? null,
    properties: (rec.properties as Record<string, unknown>) ?? {},
  };
}

function computeBBox(fc: GeoJSONFeatureCollection): [number, number, number, number] | null {
  const lngs: number[] = [];
  const lats: number[] = [];

  function collectCoords(coords: unknown): void {
    if (!Array.isArray(coords)) return;
    if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
      // Leaf coordinate: [lng, lat]
      lngs.push(coords[0]);
      lats.push(coords[1]);
    } else {
      for (const item of coords) {
        collectCoords(item);
      }
    }
  }

  for (const f of fc.features) {
    if (f.geometry?.coordinates) {
      collectCoords(f.geometry.coordinates);
    }
  }

  if (lngs.length === 0) return null;

  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

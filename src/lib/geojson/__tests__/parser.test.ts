/**
 * GeoJSON bbox computation (finding L5): computeBBox must handle geometries with
 * more than ~100k coordinates. The old `Math.min(...lngs)` spread throws
 * `RangeError: Maximum call stack size exceeded` past the argument-count limit —
 * exactly when a real polygon/LineString is large enough to matter.
 */
import { describe, it, expect } from "vitest";
import { parseGeoJSON } from "@/lib/geojson/parser";

describe("parseGeoJSON — large-geometry bbox", () => {
  it("computes a bbox for a geometry with >100k coordinates without throwing", () => {
    const N = 150_000;
    const coords: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      // lng sweeps 0…149999 (scaled), lat is a small varying value; the extremes
      // are known so we can assert the bbox exactly.
      coords.push([i * 0.001, (i % 7) - 3]);
    }
    const fc = {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} },
      ],
    };

    let parsed!: ReturnType<typeof parseGeoJSON>;
    expect(() => {
      parsed = parseGeoJSON(JSON.stringify(fc));
    }).not.toThrow();

    expect(parsed.bbox).not.toBeNull();
    const [minLng, minLat, maxLng, maxLat] = parsed.bbox!;
    expect(minLng).toBeCloseTo(0, 6);
    expect(maxLng).toBeCloseTo((N - 1) * 0.001, 6);
    expect(minLat).toBe(-3);
    expect(maxLat).toBe(3);
  });

  it("returns null bbox when there are no coordinates", () => {
    const fc = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: null, properties: { a: "1" } }],
    };
    expect(parseGeoJSON(JSON.stringify(fc)).bbox).toBeNull();
  });
});

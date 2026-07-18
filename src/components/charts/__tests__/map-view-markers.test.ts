import { describe, it, expect } from "vitest";
import { normalizeMarkers } from "@/components/charts/map-view";

describe("normalizeMarkers", () => {
  it("keeps lat/lng markers as-is", () => {
    const out = normalizeMarkers([{ lat: 47.6, lng: -122.3, label: "A" }]);
    expect(out).toEqual([{ lat: 47.6, lng: -122.3, label: "A" }]);
  });

  it("maps `lon` to `lng` (DuckDB ST_X(...) AS lon) so the map still plots", () => {
    const out = normalizeMarkers([
      { lat: 47.558092, lon: -122.390494, nn_dist_m: 9.4, class: "house" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].lat).toBe(47.558092);
    expect(out[0].lng).toBe(-122.390494);
  });

  it("maps `latitude`/`longitude` aliases", () => {
    const out = normalizeMarkers([{ latitude: 40.7, longitude: -74 }]);
    expect(out[0].lat).toBe(40.7);
    expect(out[0].lng).toBe(-74);
  });

  it("drops rows without finite coordinates and non-arrays", () => {
    expect(normalizeMarkers([{ lat: 1 }, { lng: 2 }, { lat: "x", lng: 3 }])).toEqual([]);
    expect(normalizeMarkers(null)).toEqual([]);
    expect(normalizeMarkers(undefined)).toEqual([]);
  });
});

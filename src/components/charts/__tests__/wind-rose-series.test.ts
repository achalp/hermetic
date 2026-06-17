import { describe, it, expect } from "vitest";
import { buildWindRoseSeries } from "../wind-rose-chart";

// These shapes are taken from real LLM output captured against wind data:
// the model commonly mis-declares direction_key and emits either a wide pivot
// or a long table. buildWindRoseSeries must render both regardless.

describe("buildWindRoseSeries", () => {
  it("handles WIDE pivot {direction, <band>: freq} with a wrong direction_key", () => {
    const rows = [
      { direction: "N", "0-10 km/h": 5, "11-20 km/h": 3 },
      { direction: "W", "0-10 km/h": 16, "11-20 km/h": 12 },
      { direction: "SW", "0-10 km/h": 14, "11-20 km/h": 10 },
    ];
    // direction_key is wrong ("wind_dir" absent); bucket/value null (wide).
    const out = buildWindRoseSeries(rows, {
      direction_key: "wind_dir",
      bucket_key: null,
      value_key: null,
    });
    expect(out.buckets).toEqual(["0-10 km/h", "11-20 km/h"]);
    expect(out.plotted).toBe(6); // 3 directions × 2 bands
    // W band "0-10 km/h" should be 16 at theta 270
    const band0 = out.petals[0];
    const wIdx = band0.theta.indexOf(270);
    expect(band0.radial[wIdx]).toBe(16);
  });

  it("handles LONG {direction, direction_deg, speed_band, frequency} with wrong direction_key", () => {
    const rows = [
      { direction: "N", direction_deg: 0, speed_band: "0-10", frequency: 5 },
      { direction: "N", direction_deg: 0, speed_band: "10-20", frequency: 3 },
      { direction: "W", direction_deg: 270, speed_band: "0-10", frequency: 16 },
    ];
    const out = buildWindRoseSeries(rows, {
      direction_key: "wind_dir", // wrong — should auto-detect "direction"
      bucket_key: "speed_band",
      value_key: "frequency",
    });
    expect(out.buckets).toEqual(["0-10", "10-20"]);
    expect(out.plotted).toBe(3);
    // direction_deg must NOT have been treated as a band
    expect(out.buckets).not.toContain("direction_deg");
  });

  it("does not treat a *_deg column as a band in wide format", () => {
    const rows = [
      { direction: "N", direction_deg: 0, "0-10": 5 },
      { direction: "E", direction_deg: 90, "0-10": 8 },
    ];
    const out = buildWindRoseSeries(rows, {
      direction_key: "direction",
      bucket_key: null,
      value_key: null,
    });
    expect(out.buckets).toEqual(["0-10"]);
  });

  it("parses numeric degree directions", () => {
    const rows = [
      { direction: 45, freq: 4 },
      { direction: 225, freq: 9 },
    ];
    const out = buildWindRoseSeries(rows, {
      direction_key: "direction",
      bucket_key: null,
      value_key: null,
    });
    expect(out.plotted).toBe(2);
    expect(out.petals[0].theta.sort((a, b) => a - b)).toEqual([45, 225]);
  });

  it("returns empty for no rows or no parseable direction", () => {
    expect(buildWindRoseSeries([], {}).plotted).toBe(0);
    const out = buildWindRoseSeries([{ a: "x", b: 1 }], {
      direction_key: "dir",
      bucket_key: null,
      value_key: null,
    });
    // "a" is the only non-numeric col but values aren't compass-like; "b" is
    // numeric → treated as a band, but direction can't resolve to theta → empty.
    expect(out.plotted).toBe(0);
  });
});

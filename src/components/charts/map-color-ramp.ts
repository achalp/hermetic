import { BASEMAP_TILE_URLS } from "@/lib/constants";

/**
 * Dependency-free color-ramp + basemap helpers for the deck.gl maps. Kept out of
 * the deck.gl component files (which pull WebGL) so they stay unit-testable.
 */

/** Carto basemaps — free, keyless. Retina (@2x) for crisp labels. */
export const BASEMAP_TILES: Record<"dark" | "light", string> = {
  dark: BASEMAP_TILE_URLS.dark,
  light: BASEMAP_TILE_URLS.light,
};

/**
 * Turbo color ramp (dark blue → cyan → green → orange → dark red). Every stop is
 * saturated and mid-to-dark, so points stay legible on a LIGHT basemap (unlike a
 * plasma ramp whose pale-yellow high end washes out on white). Used to shade map
 * points by a numeric value.
 */
const TURBO: [number, number, number][] = [
  [48, 18, 59],
  [33, 144, 241],
  [30, 222, 184],
  [166, 249, 68],
  [253, 152, 39],
  [122, 4, 3],
];

/** Interpolated Turbo color for t in [0,1] (clamped). */
export function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, isFinite(t) ? t : 0)) * (TURBO.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = TURBO[i];
  const b = TURBO[Math.min(i + 1, TURBO.length - 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Min/max of a numeric field across rows, or null when not a usable range. */
export function numericRange(
  data: Record<string, unknown>[],
  key: string | null | undefined
): { min: number; max: number } | null {
  if (!key) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const d of data) {
    const n = Number(d[key]);
    if (isFinite(n)) {
      if (n < min) min = n;
      if (n > max) max = n;
    }
  }
  return isFinite(min) && isFinite(max) && max > min ? { min, max } : null;
}

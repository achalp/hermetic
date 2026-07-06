/**
 * Dependency-free color-ramp + basemap helpers for the deck.gl maps. Kept out of
 * the deck.gl component files (which pull WebGL) so they stay unit-testable.
 */

/** Carto basemaps — free, keyless. Retina (@2x) for crisp labels. */
export const BASEMAP_TILES: Record<"dark" | "light", string> = {
  dark: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
  light: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
};

/**
 * Plasma color ramp (dark violet → magenta → orange → yellow) — vivid on a dark
 * basemap. Used to shade map points by a numeric value.
 */
const PLASMA: [number, number, number][] = [
  [13, 8, 135],
  [126, 3, 168],
  [204, 71, 120],
  [248, 149, 64],
  [240, 249, 33],
];

/** Interpolated plasma color for t in [0,1] (clamped). */
export function rampColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, isFinite(t) ? t : 0)) * (PLASMA.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = PLASMA[i];
  const b = PLASMA[Math.min(i + 1, PLASMA.length - 1)];
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

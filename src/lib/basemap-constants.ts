/**
 * External map/export asset endpoints. Self-hosters point these at their own
 * infrastructure (config override lands with HermeticConfig, WS3).
 *
 * A leaf module (no imports) because middleware.ts derives its CSP host list
 * from these values and compiles for the Edge runtime — importing constants.ts
 * there would evaluate envConfig() in a module graph the harness never boots.
 * constants.ts re-exports these, so app/renderer code keeps importing from
 * "@/lib/constants".
 *
 * Basemaps are OpenFreeMap (openfreemap.org): keyless, no registration, no
 * usage limits, commercial use allowed, donation-funded. Chosen after CARTO
 * began watermarking anonymous raster tiles with "API KEY REQUIRED" (issue
 * #253) — verified 2026-09-17 that OpenFreeMap styles carry no watermark
 * layers and every sub-resource (tiles, glyphs, sprites, natural-earth
 * rasters) serves anonymously from this single origin. Attribution is
 * required and MapLibre injects it automatically from the style.
 */
export const BASEMAP_STYLE_URLS = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
} as const;
/** The default (light) style — what MapView renders under pins/regions. */
export const BASEMAP_STYLE_URL = BASEMAP_STYLE_URLS.light;
export const REVEALJS_CDN_URL = "https://cdn.jsdelivr.net/npm/reveal.js@5.1.0";

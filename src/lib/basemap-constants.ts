/**
 * External map/export asset endpoints. Self-hosters point these at their own
 * infrastructure (config override lands with HermeticConfig, WS3).
 *
 * A leaf module (no imports) because middleware.ts derives its CSP host list
 * from these values and compiles for the Edge runtime — importing constants.ts
 * there would evaluate envConfig() in a module graph the harness never boots.
 * constants.ts re-exports these, so app/renderer code keeps importing from
 * "@/lib/constants".
 */
export const BASEMAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
export const BASEMAP_TILE_URLS = {
  dark: "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png",
  light: "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
} as const;
export const REVEALJS_CDN_URL = "https://cdn.jsdelivr.net/npm/reveal.js@5.1.0";

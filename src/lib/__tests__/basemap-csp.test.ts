import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASEMAP_STYLE_URL, BASEMAP_TILE_URLS } from "@/lib/basemap-constants";

/**
 * The desktop app's CSP must permit every host the basemap actually fetches from
 * (build log D23).
 *
 * This failed SILENTLY before: MapLibre's pins are DOM markers so they rendered
 * fine, while the style JSON and tiles were blocked — the map looked like a blank
 * white box with correct-looking attribution. Nothing threw, no test caught it, and
 * it only showed up on the packaged desktop app (the browser has no Tauri CSP).
 *
 * Binding the CSP to the constants means changing either one alone fails here.
 */
const CSP = (() => {
  const conf = readFileSync(join(process.cwd(), "src-tauri", "tauri.conf.json5"), "utf8");
  return /csp:\s*"([^"]+)"/.exec(conf)?.[1] ?? "";
})();

function directive(name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s([^;]*)`).exec(CSP);
  return m ? m[1] : "";
}

/** Does `sources` admit `host` — exactly, or via a `*.` wildcard? */
function admits(sources: string, host: string): boolean {
  return sources.split(/\s+/).some((src) => {
    if (src === `https://${host}`) return true;
    const w = /^https:\/\/\*\.(.+)$/.exec(src);
    return w ? host === w[1] || host.endsWith(`.${w[1]}`) : false;
  });
}

describe("desktop CSP admits the basemap", () => {
  it("parses a csp out of tauri.conf.json5", () => {
    expect(CSP).toContain("default-src");
  });

  it("allows the STYLE url on connect-src (fetched as JSON, not an image)", () => {
    const host = new URL(BASEMAP_STYLE_URL).hostname;
    expect(admits(directive("connect-src"), host)).toBe(true);
  });

  it("allows every TILE host on img-src — raster tiles load as images", () => {
    for (const url of Object.values(BASEMAP_TILE_URLS)) {
      // Tile templates carry {z}/{x}/{y}; only the origin matters here.
      const host = new URL(url.replace(/\{[zxy]\}/g, "0")).hostname;
      expect(admits(directive("img-src"), host), `img-src must admit ${host}`).toBe(true);
    }
  });

  it("does NOT widen anything else — no wildcard scripts, no default-src escape", () => {
    expect(directive("script-src")).not.toContain("*");
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(directive("default-src").trim()).toBe("'self'");
    expect(directive("object-src").trim()).toBe("'none'");
  });
});

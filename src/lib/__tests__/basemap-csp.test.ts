import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASEMAP_STYLE_URLS } from "@/lib/basemap-constants";

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

  it("allows every STYLE host on connect-src — MapLibre fetches styles, tiles, glyphs and sprites", () => {
    for (const url of Object.values(BASEMAP_STYLE_URLS)) {
      const host = new URL(url).hostname;
      expect(admits(directive("connect-src"), host), `connect-src must admit ${host}`).toBe(true);
    }
  });

  it("allows every STYLE host on img-src — sprite/raster sub-resources may load as images", () => {
    for (const url of Object.values(BASEMAP_STYLE_URLS)) {
      const host = new URL(url).hostname;
      expect(admits(directive("img-src"), host), `img-src must admit ${host}`).toBe(true);
    }
  });

  it("basemap URLs stay keyless — a token in the URL is the CARTO regression returning", () => {
    // CARTO began watermarking anonymous raster tiles ("API KEY REQUIRED",
    // issue #253); the OpenFreeMap replacement is keyless BY DESIGN. A key or
    // token appearing in these URLs means the provider posture changed again
    // and needs a deliberate decision, not a silent pass-through.
    for (const url of Object.values(BASEMAP_STYLE_URLS)) {
      expect(url).not.toMatch(/token|apikey|api_key|key=/i);
      expect(url).toContain("openfreemap.org");
    }
  });

  it("does NOT widen anything else — no wildcard scripts, no default-src escape", () => {
    expect(directive("script-src")).not.toContain("*");
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(directive("default-src").trim()).toBe("'self'");
    expect(directive("object-src").trim()).toBe("'none'");
  });
});

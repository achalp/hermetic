#!/usr/bin/env node
/**
 * Build the MCP embedded viewer bundle (mcp-server spec §4 M3).
 *
 * Three artifacts into src/mcp/viewer/dist/ (gitignored):
 *   app.css — the app's Tailwind v4 stylesheet compiled via the same
 *     @tailwindcss/postcss plugin the Next build uses, plus the mapping of
 *     --font-geist-sans/mono onto the self-hosted Geist families (next/font
 *     provides those variables in the web app; here @fontsource does).
 *   viewer.js (+ code-split chunks, + viewer.css)  — esbuild over entry.tsx;
 *     the lazy chart imports (clientLazy) become async chunks, so plotly/maps
 *     load only when a dashboard uses them. viewer.css carries the @font-face
 *     rules from the fontsource imports; woff2 files land in dist/fonts/.
 *   viewer.html — the shell, linking app.css plus every emitted stylesheet.
 *
 * This build cashes the isolation-check guarantee: the renderer closure
 * compiles alone, so a browser bundle of it needs no Next.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindPostcss from "@tailwindcss/postcss";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/mcp/viewer/dist");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 1. Tailwind CSS (globals.css → app.css) ──
// The web app gets --font-geist-sans/mono from next/font (layout.tsx); the
// viewer self-hosts Geist via @fontsource-variable (bundled by step 2), so
// the same variables map onto those family names here.
const FONT_VARS = `:root{--font-geist-sans:'Geist Variable',ui-sans-serif,system-ui,sans-serif;--font-geist-mono:'Geist Mono Variable',ui-monospace,SFMono-Regular,monospace;}\n`;
const cssIn = join(ROOT, "src/app/globals.css");
const cssResult = await postcss([tailwindPostcss()]).process(readFileSync(cssIn, "utf-8"), {
  from: cssIn,
  to: join(OUT, "app.css"),
});
writeFileSync(join(OUT, "app.css"), cssResult.css + FONT_VARS);
console.error(`app.css: ${(cssResult.css.length / 1024).toFixed(0)}KB`);

// ── 2. JS bundle ──
const result = await build({
  entryPoints: [join(ROOT, "src/mcp/viewer/entry.tsx")],
  outdir: OUT,
  bundle: true,
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: false,
  metafile: true,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: {
    ".css": "css",
    ".woff": "file",
    ".woff2": "file",
    ".png": "dataurl",
    ".svg": "dataurl",
  },
  alias: { "@": join(ROOT, "src") },
  entryNames: "viewer",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "fonts/[name]-[hash]",
  // url() references in emitted css must resolve against the server route.
  publicPath: "/assets",
});
const outputs = Object.entries(result.metafile.outputs);
const total = outputs.reduce((s, [, o]) => s + o.bytes, 0);
console.error(
  `viewer bundle: ${outputs.length} files, ${(total / 1024 / 1024).toFixed(1)}MB total`
);

// ── 3. Shell page ──
// ESM code-splitting does not auto-load chunk CSS (maplibre etc. ride the
// lazy chart chunks) — link every emitted stylesheet up front; they are
// small relative to the charts that need them. app.css first so the theme
// tokens exist before component styles apply.
const cssLinks = outputs
  .map(([file]) => file.slice(file.indexOf("dist/") + 5))
  .filter((f) => f.endsWith(".css"))
  .map((f) => `<link rel="stylesheet" href="/assets/${f}" />`)
  .join("\n");
writeFileSync(
  join(OUT, "viewer.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>hermetic — analysis</title>
<link rel="stylesheet" href="/assets/app.css" />
${cssLinks}
</head>
<body class="antialiased"><div id="root"></div><script type="module" src="/assets/viewer.js"></script></body>
</html>
`
);
console.error("viewer.html written");

// ── 4. Single-file export bundles (specs/dashboard-distribution-2026-08-05.md) ──
// Two IIFE profiles, no code-splitting (a single HTML file cannot load
// chunks): STANDARD carries core + nivo + plotly-cartesian and stubs the
// heavy families; FULL carries everything. Both stub the export-again
// libraries (exceljs/jspdf/pptxgen/html-to-image) — a shared file doesn't
// need to produce PowerPoints, and they'd cost ~3.5MB in every export.
// The assembler (lib/export/html-export.ts) picks the profile by walking
// the spec's component types against export-manifest.json.

const CHART_STUB = join(ROOT, "src/mcp/viewer/export-stubs/unavailable-chart.tsx");
const LIBS_STUB = join(ROOT, "src/mcp/viewer/export-stubs/no-export-libs.ts");

/** esbuild plugin: redirect module paths matching `patterns` to a stub file. */
function stubPlugin(name, patterns, stubFile) {
  const re = new RegExp(patterns.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  return {
    name,
    setup(b) {
      b.onResolve({ filter: re }, (args) => {
        // Only redirect the real module, never the stub resolving itself.
        if (args.importer.includes("export-stubs")) return null;
        return { path: stubFile };
      });
    },
  };
}

const HEAVY_CHART_MODULES = [
  "plotly-3d-wrapper",
  "plotly-finance-wrapper",
  "plotly-polar-wrapper",
  "charts/map-view",
  "charts/map3d-view",
  "charts/globe-view",
];
const EXPORT_AGAIN_LIBS = ["exceljs", "jspdf", "pptxgenjs", "html-to-image"];

async function buildExportProfile(profile) {
  const plugins = [stubPlugin("stub-export-libs", EXPORT_AGAIN_LIBS, LIBS_STUB)];
  if (profile === "standard") {
    plugins.push(stubPlugin("stub-heavy-charts", HEAVY_CHART_MODULES, CHART_STUB));
  }
  const res = await build({
    entryPoints: [join(ROOT, "src/mcp/viewer/export-entry.tsx")],
    outfile: join(OUT, `export-${profile}.js`),
    bundle: true,
    format: "iife",
    splitting: false,
    minify: true,
    sourcemap: false,
    metafile: true,
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
    // Everything inlines: fonts as data URIs (single-file constraint).
    loader: {
      ".css": "css",
      ".woff": "dataurl",
      ".woff2": "dataurl",
      ".png": "dataurl",
      ".svg": "dataurl",
    },
    alias: { "@": join(ROOT, "src") },
    plugins,
  });
  // Separation proof: the standard profile must not contain the heavy libs.
  if (profile === "standard") {
    const leaked = Object.keys(res.metafile.inputs).filter((i) =>
      /plotly\.js-(gl3d|finance)|maplibre-gl|react-globe|deck\.gl|three\//.test(i)
    );
    if (leaked.length) {
      console.error(`export-standard leaked heavy inputs:\n  ${leaked.slice(0, 5).join("\n  ")}`);
      process.exit(1);
    }
  }
  const js = statSync(join(OUT, `export-${profile}.js`)).size;
  const cssPath = join(OUT, `export-${profile}.css`);
  const css = existsSync(cssPath) ? statSync(cssPath).size : 0;
  console.error(
    `export-${profile}: js ${(js / 1024 / 1024).toFixed(1)}MB, css ${(css / 1024).toFixed(0)}KB`
  );
  return { js, css };
}

const std = await buildExportProfile("standard");
const full = await buildExportProfile("full");

// ── 5. Export app.css (fonts inlined) + manifest ──
// The viewer's app.css references /assets/fonts/… — a single file cannot.
// Rebuild the tailwind output with font url()s replaced by data URIs.
const appCss = readFileSync(join(OUT, "app.css"), "utf-8");
const exportAppCss = appCss.replace(/url\((\/assets\/fonts\/[^)]+)\)/g, (m, p) => {
  const f = join(OUT, p.replace("/assets/", ""));
  if (!existsSync(f)) return m;
  return `url(data:font/woff2;base64,${readFileSync(f).toString("base64")})`;
});
writeFileSync(join(OUT, "export-app.css"), exportAppCss);

// Catalog types only renderable by the FULL profile — derived from which
// chart modules the standard profile stubs (see registry.tsx bindings).
// scripts/check-export-types.mjs? (v1: verified by the assembler test.)
const FULL_ONLY_TYPES = [
  "CandlestickChart",
  "ContourChart",
  "FunnelChart",
  "GaugeChart",
  "Globe3D",
  "Map3D",
  "MapView",
  "QuiverChart",
  "Scatter3D",
  "Surface3D",
  "TernaryChart",
  "WaterfallChart",
  "WindRose",
];
writeFileSync(
  join(OUT, "export-manifest.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      fullOnlyTypes: FULL_ONLY_TYPES,
      profiles: {
        standard: { js: "export-standard.js", css: "export-standard.css", bytes: std.js + std.css },
        full: { js: "export-full.js", css: "export-full.css", bytes: full.js + full.css },
      },
    },
    null,
    2
  ) + "\n"
);
console.error("export-manifest.json written");

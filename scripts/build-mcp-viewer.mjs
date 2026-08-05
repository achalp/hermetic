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
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

#!/usr/bin/env node
/**
 * Build the MCP embedded viewer bundle (mcp-server spec §4 M3).
 *
 * Two artifacts into src/mcp/viewer/dist/ (gitignored):
 *   viewer.js (+ code-split chunks)  — esbuild over entry.tsx; the lazy
 *     chart imports (clientLazy) become async chunks, so plotly/maps load
 *     only when a dashboard uses them.
 *   viewer.css — the app's Tailwind v4 stylesheet compiled via the same
 *     @tailwindcss/postcss plugin the Next build uses, plus any css the
 *     chart modules import (esbuild emits those alongside the js).
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

// ── 1. Tailwind CSS (globals.css → viewer.css) ──
const cssIn = join(ROOT, "src/app/globals.css");
const cssResult = await postcss([tailwindPostcss()]).process(readFileSync(cssIn, "utf-8"), {
  from: cssIn,
  to: join(OUT, "viewer.css"),
});
writeFileSync(join(OUT, "viewer.css"), cssResult.css);
console.error(`viewer.css: ${(cssResult.css.length / 1024).toFixed(0)}KB`);

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
  loader: { ".css": "css", ".woff": "file", ".woff2": "file", ".png": "dataurl", ".svg": "dataurl" },
  alias: { "@": join(ROOT, "src") },
  entryNames: "viewer",
  chunkNames: "chunks/[name]-[hash]",
});
const outputs = Object.entries(result.metafile.outputs);
const total = outputs.reduce((s, [, o]) => s + o.bytes, 0);
console.error(
  `viewer bundle: ${outputs.length} files, ${(total / 1024 / 1024).toFixed(1)}MB total`
);

// ── 3. Shell page ──
// ESM code-splitting does not auto-load chunk CSS (maplibre etc. ride the
// lazy chart chunks) — link every emitted stylesheet up front; they are
// small relative to the charts that need them.
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
<link rel="stylesheet" href="/assets/viewer.css" />
${cssLinks}
</head>
<body><div id="root"></div><script type="module" src="/assets/viewer.js"></script></body>
</html>
`
);
console.error("viewer.html written");

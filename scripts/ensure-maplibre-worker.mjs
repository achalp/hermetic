#!/usr/bin/env node
/**
 * Vendor MapLibre's worker module into public/ — the fix for silently blank
 * basemaps (issue #253 follow-up).
 *
 * maplibre-gl v6 ships its worker as a SEPARATE module file and spawns it from
 * `new URL("./maplibre-gl-worker.mjs", import.meta.url)`. Inside a bundled
 * Next app, import.meta.url points at an emitted chunk, the worker file is not
 * emitted next to it, the fetch 404s — and the map stalls forever with style
 * metadata loaded but zero tile requests and no visible error. Pins (DOM
 * markers) still render, so the failure reads as "blank map", the same
 * dev-state-masking family as the pyodide wheels.
 *
 * The map components call setWorkerUrl() to point MapLibre at this vendored
 * copy instead. Copying at build/dev time (not committing) keeps the worker
 * byte-identical to the installed maplibre-gl version — the pair MUST come
 * from the same build or the actor protocol can skew.
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "node_modules", "maplibre-gl", "dist");
const OUT = join(ROOT, "public", "vendor", "maplibre");

// The worker imports ./maplibre-gl-shared.mjs relative to its own URL, so the
// two files must be served side by side.
const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(OUT, { recursive: true });
for (const f of FILES) {
  const src = join(SRC, f);
  if (!existsSync(src)) {
    console.error(`ensure-maplibre-worker: ${src} missing — maplibre-gl not installed?`);
    process.exit(1);
  }
  copyFileSync(src, join(OUT, f));
}
// Fail loud on an implausibly small copy (a truncated worker "works" as a 404
// does: silently).
for (const f of FILES) {
  const size = statSync(join(OUT, f)).size;
  if (size < 10_000) {
    console.error(`ensure-maplibre-worker: ${f} is ${size} bytes — implausibly small`);
    process.exit(1);
  }
}
console.log(`maplibre worker vendored into public/vendor/maplibre (${FILES.join(", ")})`);

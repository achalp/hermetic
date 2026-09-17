"use client";

/**
 * Point MapLibre at the vendored worker module BEFORE any Map constructs.
 *
 * maplibre-gl v6 spawns its worker from `new URL("./maplibre-gl-worker.mjs",
 * import.meta.url)`. Bundled, that resolves next to a Next chunk where no such
 * file exists; the 404 is swallowed and every map stalls with style metadata
 * loaded but zero tile requests — pins render (DOM), basemap stays blank.
 * scripts/ensure-maplibre-worker.mjs copies the version-matched worker (plus
 * its maplibre-gl-shared.mjs sibling) into public/vendor/maplibre at
 * build/dev time; this module is imported for its side effect by every map
 * component, so the override always precedes the first Map.
 */
import { setWorkerUrl } from "maplibre-gl";

setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");

/**
 * Manifest entry point: detect + adapt (spec §4/§5). Adapter order is FIXED —
 * datapackage, croissant, files-array — because the shapes overlap: a
 * datapackage also has arrays a files-array scan would match, so the more
 * specific standard must win. First match wins; no match is a user-facing
 * ManifestError naming the supported forms.
 */
import type { DatasetManifest } from "@/lib/contracts/dataset-manifest";
import { adaptCroissant, adaptDatapackage, adaptFilesArray } from "./adapters";
import { ManifestError } from "./shared";

const ADAPTERS = [adaptDatapackage, adaptCroissant, adaptFilesArray] as const;

export function parseDatasetManifest(json: unknown, manifestUrl: string): DatasetManifest {
  for (const adapt of ADAPTERS) {
    const manifest = adapt(json, manifestUrl);
    if (manifest) return manifest;
  }
  throw new ManifestError(
    "This JSON is not a manifest form Hermetic recognizes. Supported: a Frictionless " +
      "Data Package (datapackage.json with resources[]), a Croissant / schema.org " +
      "Dataset (JSON-LD with distribution[]), or a files-array manifest " +
      "(files/resources/datasets: [{name, url, …}]) with at least one .parquet entry."
  );
}

/** Text → JSON → manifest, with a BOM strip and a JSON-specific error. */
export function parseDatasetManifestText(text: string, manifestUrl: string): DatasetManifest {
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw new ManifestError(
      "That URL did not return valid JSON — a manifest must be a JSON document."
    );
  }
  return parseDatasetManifest(json, manifestUrl);
}

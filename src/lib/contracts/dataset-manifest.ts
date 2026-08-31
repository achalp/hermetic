/**
 * The NORMALIZED shape every manifest adapter produces (spec:
 * specs/dataset-manifests-2026-08-30.md §4). There is no single manifest
 * standard in the wild — datapackage and Croissant are real standards, OpenAlex
 * -style `files[]` arrays are the dominant convention — so the adapters map each
 * recognized format into THIS, and everything downstream (introspection, entity
 * browser, selection pre-step, prompt context, execution) is format-agnostic.
 *
 * Types only: the parsing, limits, and gates live in lib/manifest/*.
 */

export interface ManifestEntity {
  /** Display + selection name, unique within the manifest (slugified). */
  name: string;
  /** One url (single parquet) or a prefix/glob (hive tree) — same host as manifest. */
  url: string;
  isHivePartitioned?: boolean;
  /** From the manifest itself — available BEFORE any parquet is touched. */
  description?: string;
  rowCountHint?: number;
  bytesHint?: number;
  sha256?: string;
  /** Column docs harvested from the adapter (datapackage/croissant), if present. */
  columnDocs?: { name: string; description: string }[];
}

export type DatasetManifestFormat = "datapackage" | "croissant" | "files-array" | "stac";

export interface DatasetManifest {
  manifestUrl: string;
  format: DatasetManifestFormat;
  title?: string;
  description?: string;
  license?: string;
  /** ≤ MAX_MANIFEST_ENTITIES (lib/manifest/shared.ts); over the cap fails loudly. */
  entities: ManifestEntity[];
}

/** An entry the same-host gate (or an adapter) refused, kept for UI display. */
export interface ExcludedEntry {
  name: string;
  url: string;
  reason: string;
}

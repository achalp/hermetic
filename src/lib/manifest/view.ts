/**
 * Wire views of a connected manifest (spec §6): the entity LIST the browser
 * renders (hints + status, no schemas — 200 entities must stay a light
 * payload) and the per-entity DETAIL (full schema + samples + docs) fetched on
 * click. Pure projections of the store record, so both are unit-tested without
 * routes.
 */
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { ExcludedEntry } from "@/lib/contracts/dataset-manifest";
import type { EntityStatus, ManifestRecord } from "./store";

export interface ManifestEntityView {
  name: string;
  url: string;
  description?: string;
  /** From the manifest until introspection; exact after. */
  rowCount?: number;
  rowCountIsExact: boolean;
  bytesHint?: number;
  columnCount?: number;
  status: EntityStatus;
  csvId?: string;
  error?: string;
  hasColumnDocs: boolean;
}

export interface ManifestView {
  manifestId: string;
  manifestUrl: string;
  format: string;
  title?: string;
  description?: string;
  license?: string;
  entities: ManifestEntityView[];
  excluded: ExcludedEntry[];
}

export function manifestView(record: ManifestRecord): ManifestView {
  const m = record.manifest;
  return {
    manifestId: record.manifestId,
    manifestUrl: m.manifestUrl,
    format: m.format,
    ...(m.title ? { title: m.title } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(m.license ? { license: m.license } : {}),
    excluded: record.excluded,
    entities: [...record.entities.values()].map((s) => ({
      name: s.entity.name,
      url: s.entity.url,
      ...(s.entity.description ? { description: s.entity.description } : {}),
      ...(s.rowCount !== undefined
        ? { rowCount: s.rowCount, rowCountIsExact: true }
        : s.entity.rowCountHint !== undefined
          ? { rowCount: s.entity.rowCountHint, rowCountIsExact: false }
          : { rowCountIsExact: false }),
      ...(s.entity.bytesHint !== undefined ? { bytesHint: s.entity.bytesHint } : {}),
      ...(s.columnCount !== undefined ? { columnCount: s.columnCount } : {}),
      status: s.status,
      ...(s.csvId ? { csvId: s.csvId } : {}),
      ...(s.error ? { error: s.error } : {}),
      hasColumnDocs: Boolean(s.entity.columnDocs?.length),
    })),
  };
}

export interface ManifestEntityDetail {
  name: string;
  status: EntityStatus;
  url: string;
  description?: string;
  csvId?: string;
  /** Full schema (columns + sample_rows) once ready. */
  schema?: CSVSchema;
  /** Column docs from the manifest, merged for display alongside the schema. */
  columnDocs?: { name: string; description: string }[];
  error?: string;
}

export function entityDetail(
  record: ManifestRecord,
  name: string,
  getSchema: (csvId: string) => CSVSchema | undefined
): ManifestEntityDetail | null {
  const s = record.entities.get(name);
  if (!s) return null;
  const schema = s.csvId ? getSchema(s.csvId) : undefined;
  return {
    name: s.entity.name,
    status: s.status,
    url: s.entity.url,
    ...(s.entity.description ? { description: s.entity.description } : {}),
    ...(s.csvId ? { csvId: s.csvId } : {}),
    ...(schema ? { schema } : {}),
    ...(s.entity.columnDocs?.length ? { columnDocs: s.entity.columnDocs } : {}),
    ...(s.error ? { error: s.error } : {}),
  };
}

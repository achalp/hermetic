/**
 * The three v1 manifest adapters (spec §2/§4): datapackage, Croissant/schema.org,
 * and the generic files-array convention. Each is a PURE, throw-free-on-mismatch
 * parser: `(json, manifestUrl) => DatasetManifest | null`, where null means "not
 * my format" and the next adapter tries. Only `finalizeEntities` may throw (the
 * loud over-cap failure), and only after a format HAS matched.
 *
 * Shared posture: the manifest is untrusted. Every string is clamped
 * (`clampText`), every URL resolved (`resolveEntryUrl`) and filtered to parquet
 * (`isParquetish`); the same-host gate runs AFTER adaptation (same-host.ts) so
 * exclusions can be shown per entry rather than failing the parse.
 */
import type { DatasetManifest, ManifestEntity } from "@/lib/contracts/dataset-manifest";
import {
  clampText,
  entityNameFrom,
  finalizeEntities,
  isParquetish,
  resolveEntryUrl,
  sha256From,
  toCountHint,
  MAX_COLUMN_DOC_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
} from "./shared";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Column docs from a frictionless Table Schema / croissant field list. */
function columnDocsFrom(fields: unknown[]): ManifestEntity["columnDocs"] {
  const docs = fields.flatMap((f) => {
    if (!isRec(f)) return [];
    const name = clampText(f.name, MAX_NAME_CHARS);
    const description = clampText(f.description, MAX_COLUMN_DOC_CHARS);
    return name && description ? [{ name, description }] : [];
  });
  return docs.length > 0 ? docs : undefined;
}

// ── Adapter 1: Frictionless Data Package (datapackage.json) ──────────────────
// Detection: `resources` array of objects with a `path`. Harvest: parquet
// resources only; relative paths resolve against the manifest URL (and are
// therefore same-host by construction); Table Schema fields → columnDocs.
export function adaptDatapackage(json: unknown, manifestUrl: string): DatasetManifest | null {
  if (!isRec(json)) return null;
  const resources = asArray(json.resources).filter(isRec);
  if (resources.length === 0 || !resources.some((r) => "path" in r || "data" in r)) return null;

  const entities: ManifestEntity[] = [];
  for (const r of resources) {
    // A multi-path resource (path: [..]) is N shards of one entity; v1 cannot
    // express that as one URL, so it is skipped — visible in the browser as an
    // absent entity, not silently merged into a wrong one.
    if (typeof r.path !== "string") continue;
    const url = resolveEntryUrl(r.path, manifestUrl);
    if (!url || !isParquetish(url)) continue;
    const schema = isRec(r.schema) ? r.schema : undefined;
    entities.push({
      name: entityNameFrom(typeof r.name === "string" ? r.name : undefined, url),
      url,
      ...(clampText(r.description, MAX_DESCRIPTION_CHARS)
        ? { description: clampText(r.description, MAX_DESCRIPTION_CHARS) }
        : {}),
      ...(toCountHint(r.bytes) !== undefined ? { bytesHint: toCountHint(r.bytes) } : {}),
      ...(sha256From(r.hash) ? { sha256: sha256From(r.hash) } : {}),
      ...(schema && columnDocsFrom(asArray(schema.fields))
        ? { columnDocs: columnDocsFrom(asArray(schema.fields)) }
        : {}),
    });
  }

  const licenses = asArray(json.licenses).filter(isRec);
  const license =
    clampText(json.license, MAX_NAME_CHARS) ??
    (licenses[0] ? clampText(licenses[0].name ?? licenses[0].title, MAX_NAME_CHARS) : undefined);
  return {
    manifestUrl,
    format: "datapackage",
    ...(clampText(json.title ?? json.name, MAX_NAME_CHARS)
      ? { title: clampText(json.title ?? json.name, MAX_NAME_CHARS) }
      : {}),
    ...(clampText(json.description, MAX_DESCRIPTION_CHARS)
      ? { description: clampText(json.description, MAX_DESCRIPTION_CHARS) }
      : {}),
    ...(license ? { license } : {}),
    entities: finalizeEntities(entities),
  };
}

// ── Adapter 2: Croissant / schema.org Dataset (JSON-LD) ──────────────────────
// Detection: an @context plus @type resolving to Dataset. Harvest: parquet
// FileObjects from `distribution`; a FileSet with a simple glob under a
// resolvable containedIn becomes a glob entity; recordSet fields become
// columnDocs only in the unambiguous single-entity case.
const typeOf = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v])
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.split(":").pop()!);

export function adaptCroissant(json: unknown, manifestUrl: string): DatasetManifest | null {
  if (!isRec(json) || !("@context" in json)) return null;
  if (!typeOf(json["@type"]).includes("Dataset")) return null;

  const distribution = asArray(json.distribution).filter(isRec);
  const byId = new Map<string, Rec>();
  for (const d of distribution) {
    if (typeof d["@id"] === "string") byId.set(d["@id"], d);
  }

  const parquetish = (d: Rec, url: string): boolean =>
    /parquet/i.test(typeof d.encodingFormat === "string" ? d.encodingFormat : "") ||
    isParquetish(url);

  const entities: ManifestEntity[] = [];
  for (const d of distribution) {
    const types = typeOf(d["@type"]);
    if (types.includes("FileObject")) {
      const raw = typeof d.contentUrl === "string" ? d.contentUrl : undefined;
      const url = raw ? resolveEntryUrl(raw, manifestUrl) : null;
      if (!url || !parquetish(d, url) || !isParquetish(url)) continue;
      entities.push({
        name: entityNameFrom(typeof d.name === "string" ? d.name : undefined, url),
        url,
        ...(clampText(d.description, MAX_DESCRIPTION_CHARS)
          ? { description: clampText(d.description, MAX_DESCRIPTION_CHARS) }
          : {}),
        ...(toCountHint(d.contentSize) !== undefined
          ? { bytesHint: toCountHint(d.contentSize) }
          : {}),
        ...(sha256From(d.sha256) ? { sha256: sha256From(d.sha256) } : {}),
      });
    } else if (types.includes("FileSet")) {
      // v1 FileSet support is deliberately narrow: one string glob under a
      // containedIn whose contentUrl resolves. Anything fancier is skipped
      // rather than guessed at.
      const includes = typeof d.includes === "string" ? d.includes : undefined;
      const containedIn = isRec(d.containedIn) ? d.containedIn["@id"] : d.containedIn;
      const base = typeof containedIn === "string" ? byId.get(containedIn)?.contentUrl : undefined;
      if (!includes || typeof base !== "string") continue;
      const url = resolveEntryUrl(`${base.replace(/\/+$/, "")}/${includes}`, manifestUrl);
      if (!url || !isParquetish(url)) continue;
      entities.push({
        name: entityNameFrom(typeof d.name === "string" ? d.name : undefined, url),
        url,
        ...(clampText(d.description, MAX_DESCRIPTION_CHARS)
          ? { description: clampText(d.description, MAX_DESCRIPTION_CHARS) }
          : {}),
      });
    }
  }

  // recordSet → columnDocs ONLY when the mapping is unambiguous (one recordSet,
  // one parquet entity). Croissant can bind fields to distributions precisely;
  // v1 does not attempt that join — a wrong column doc is worse than none.
  const recordSets = asArray(json.recordSet).filter(isRec);
  if (recordSets.length === 1 && entities.length === 1) {
    const docs = columnDocsFrom(asArray(recordSets[0]!.field));
    if (docs) entities[0] = { ...entities[0]!, columnDocs: docs };
  }

  if (entities.length === 0) return null;
  return {
    manifestUrl,
    format: "croissant",
    ...(clampText(json.name, MAX_NAME_CHARS)
      ? { title: clampText(json.name, MAX_NAME_CHARS) }
      : {}),
    ...(clampText(json.description, MAX_DESCRIPTION_CHARS)
      ? { description: clampText(json.description, MAX_DESCRIPTION_CHARS) }
      : {}),
    ...(clampText(json.license, MAX_NAME_CHARS)
      ? { license: clampText(json.license, MAX_NAME_CHARS) }
      : {}),
    entities: finalizeEntities(entities),
  };
}

// ── Adapter 3: generic files-array (OpenAlex / the housing manifest family) ──
// Detection: a top-level array, or an array under one of the conventional keys,
// whose entries are objects carrying a URL-ish string. Harvest: parquet entries
// only (dictionaries, markdown, licenses are metadata, not entities).
const FILES_KEYS = ["files", "resources", "datasets", "entities", "assets", "data"] as const;
const URL_KEYS = ["url", "href", "downloadUrl", "contentUrl", "location", "path"] as const;

export function adaptFilesArray(json: unknown, manifestUrl: string): DatasetManifest | null {
  const candidates: unknown[][] = [];
  if (Array.isArray(json)) candidates.push(json);
  else if (isRec(json)) {
    for (const key of FILES_KEYS) {
      if (Array.isArray(json[key])) candidates.push(json[key] as unknown[]);
    }
  }

  for (const arr of candidates) {
    const entries = arr.filter(isRec);
    if (entries.length === 0) continue;

    const entities: ManifestEntity[] = [];
    for (const e of entries) {
      const rawUrl = URL_KEYS.map((k) => e[k]).find((v): v is string => typeof v === "string");
      if (!rawUrl) continue;
      const url = resolveEntryUrl(rawUrl, manifestUrl);
      if (!url || !isParquetish(url)) continue; // dictionaries/readmes: skipped, not errors

      // yearsCovered (the housing manifest) folds into the description — it is
      // exactly the kind of hint the selection pre-step should see.
      const years = asArray(e.yearsCovered).filter((y): y is number => typeof y === "number");
      const baseDesc = clampText(e.description, MAX_DESCRIPTION_CHARS);
      const description =
        years.length > 0
          ? clampText(
              `${baseDesc ?? ""}${baseDesc ? " " : ""}(years covered: ${Math.min(...years)}–${Math.max(...years)})`,
              MAX_DESCRIPTION_CHARS
            )
          : baseDesc;

      const rows = toCountHint(e.rows ?? e.rowCount ?? e.numRows ?? e.num_rows);
      const bytes = toCountHint(e.bytes ?? e.size ?? e.contentLength);
      entities.push({
        name: entityNameFrom(typeof e.name === "string" ? e.name : undefined, url),
        url,
        ...(description ? { description } : {}),
        ...(rows !== undefined ? { rowCountHint: rows } : {}),
        ...(bytes !== undefined ? { bytesHint: bytes } : {}),
        ...(sha256From(e.sha256 ?? e.hash) ? { sha256: sha256From(e.sha256 ?? e.hash) } : {}),
      });
    }
    if (entities.length === 0) continue;

    const root = isRec(json) ? json : {};
    return {
      manifestUrl,
      format: "files-array",
      ...(clampText(root.title ?? root.name, MAX_NAME_CHARS)
        ? { title: clampText(root.title ?? root.name, MAX_NAME_CHARS) }
        : {}),
      ...(clampText(root.description, MAX_DESCRIPTION_CHARS)
        ? { description: clampText(root.description, MAX_DESCRIPTION_CHARS) }
        : {}),
      ...(clampText(root.license, MAX_NAME_CHARS)
        ? { license: clampText(root.license, MAX_NAME_CHARS) }
        : {}),
      entities: finalizeEntities(entities),
    };
  }
  return null;
}

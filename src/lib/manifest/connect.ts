/**
 * Connect-a-manifest orchestration (spec §5): fetch through the egress core →
 * adapt → same-host gate → per-entity cache check → eager-within-budget
 * introspection → store + register. Pure orchestration with injected deps
 * (the ingest.ts pattern) so the whole flow is unit-testable without docker,
 * a network, or the schema cache on disk.
 *
 * Two decisions from review live here:
 *  - the 60 s EAGER BUDGET: entities introspected inside it are ready at
 *    connect; the rest stay pending and extract lazily on first touch — so a
 *    small manifest is fully eager by construction, and a large one still
 *    connects instantly with hints from the manifest itself;
 *  - fail CLOSED when the same-host gate keeps nothing: an all-cross-host
 *    manifest is a hostile or misconfigured one, not a partial success.
 */
import { createHash } from "node:crypto";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { DatasetManifest, ManifestEntity } from "@/lib/contracts/dataset-manifest";
import { parseDatasetManifestText } from "./parse";
import { looksLikeStac, resolveStacManifest } from "./stac";
import { materializeEntities } from "./ensure";
import { partitionManifestEntities } from "./same-host";
import { ManifestError, MAX_MANIFEST_BYTES, MANIFEST_EAGER_BUDGET_MS } from "./shared";
import type { EntityState, ManifestRecord, ManifestStore } from "./store";
import { logger } from "@/lib/logger";

// Re-exported from shared.ts (moved D40 — the client's background-eager loop
// consumes the same budget).
export { MANIFEST_EAGER_BUDGET_MS } from "./shared";

/** One entity prepared for introspection (post-gate, post-normalize). */
export interface EntityTarget {
  name: string;
  readUrl: string;
  isHivePartitioned: boolean;
  sha256?: string;
}

export interface BatchOutcome {
  /** Introspected inside the budget (schema) or attempted and failed (error). */
  results: Map<string, { schema: CSVSchema } | { error: string }>;
  /** Not attempted — the budget ran out first. These stay pending. */
  skipped: string[];
}

export interface ConnectManifestDeps {
  /** Fetch the manifest document through the egress core (≤ MAX_MANIFEST_BYTES). */
  fetchManifestText(url: string, creds?: RemoteCreds): Promise<string>;
  /** Cached schema for an entity sourceKey, iff the fingerprint still matches. */
  readCachedSchema(sourceKey: string, fingerprint: string): Promise<CSVSchema | null>;
  writeCachedSchema(sourceKey: string, fingerprint: string, schema: CSVSchema): Promise<void>;
  /** Eager batch introspection (docker: one container, N entities, one budget). */
  extractBatch(
    targets: EntityTarget[],
    creds: RemoteCreds | undefined,
    budgetMs: number
  ): Promise<BatchOutcome>;
  /** Register a ready entity so the whole existing pipeline can use it. */
  registerEntity(
    csvId: string,
    schema: CSVSchema,
    readUrl: string,
    creds: RemoteCreds | undefined,
    isHivePartitioned: boolean
  ): void;
  /** True when the active runtime can run the docker batch extractor. */
  eagerCapable(): boolean;
  store: ManifestStore;
  newId(): string;
  now(): number;
}

/** The per-entity schema-cache key — SAME shape the single-entity route uses,
 *  so a manifest entity and a directly-pasted URL share one cache line. */
export function entitySourceKey(readUrl: string, creds?: RemoteCreds): string {
  return `parquet:${readUrl}:${JSON.stringify(creds ?? {})}`;
}

/** Per-entity fingerprint: the entity's own sha256 when the manifest carries
 *  one (stronger — survives manifest re-generation), else the manifest hash. */
export function entityFingerprint(entity: ManifestEntity, manifestHash: string): string {
  return entity.sha256 ? `msha:${entity.sha256}` : `mhash:${manifestHash}`;
}

export interface ConnectManifestResult {
  record: ManifestRecord;
  /** How many entities were served from the schema cache without extraction. */
  fromCache: number;
}

export async function connectDatasetManifest(
  args: { url: string; creds?: RemoteCreds; force?: boolean },
  deps: ConnectManifestDeps
): Promise<ConnectManifestResult> {
  const text = await deps.fetchManifestText(args.url, args.creds);
  if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) {
    throw new ManifestError(
      `This manifest is larger than the ${Math.round(MAX_MANIFEST_BYTES / 1e6)} MB limit.`
    );
  }
  const manifestHash = createHash("sha256").update(text).digest("hex");
  // STAC catalogs are a TREE of documents, so they route to the capped
  // traversal (which reuses THIS flow's vetted fetcher for sub-documents);
  // everything else goes through the pure single-document adapters.
  let stacJson: unknown;
  try {
    stacJson = JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    stacJson = undefined;
  }
  const parsed = looksLikeStac(stacJson)
    ? await resolveStacManifest(stacJson, args.url, {
        fetchText: (url) => deps.fetchManifestText(url, args.creds),
      })
    : parseDatasetManifestText(text, args.url);
  if (parsed.entities.length === 0) {
    throw new ManifestError(
      "This STAC catalog yielded no readable parquet collections within the traversal limits."
    );
  }

  // REVISED host policy (2026-08-31): the manifest's named hosts are the trust
  // set — entities are no longer excluded for being cross-host. Only URLs with
  // no derivable storage identity are dropped (they cannot be granted egress).
  const { kept, excluded } = partitionManifestEntities(parsed);
  if (kept.length === 0) {
    throw new ManifestError(
      `No entity in this manifest has a readable URL (${excluded.length} excluded).`
    );
  }
  if (excluded.length > 0) {
    logger.warn("Manifest connect: unreadable entity URLs excluded", {
      manifestUrl: args.url,
      excluded: excluded.length,
    });
  }
  const manifest: DatasetManifest = { ...parsed, entities: kept };

  // Cache pass then eager extraction, inside the budget — the SHARED
  // materializer (ensure.ts), so a question that lazily materializes an entity
  // later uses byte-identical cache keys, fingerprints and registration.
  // On a runtime with no batch extractor every miss stays pending and the
  // client (or MCP) drives per-entity extraction on first touch.
  const { states, fromCache, skipped } = await materializeEntities({
    entities: kept,
    manifestHash,
    ...(args.creds ? { creds: args.creds } : {}),
    deps,
    budgetMs: MANIFEST_EAGER_BUDGET_MS,
    ...(args.force ? { force: true } : {}),
    eagerCapable: deps.eagerCapable(),
  });
  const entities = new Map<string, EntityState>(states);
  for (const name of skipped) {
    if (entities.has(name)) continue;
    const e = kept.find((k) => k.name === name)!;
    entities.set(name, { entity: e, status: "pending" });
  }

  const record: ManifestRecord = {
    manifestId: deps.newId(),
    manifest,
    excluded,
    entities,
    ...(args.creds ? { creds: args.creds } : {}),
    manifestHash,
    connectedAt: deps.now(),
  };
  deps.store.put(record);

  logger.info("Manifest connected", {
    manifestId: record.manifestId,
    format: manifest.format,
    entities: kept.length,
    ready: [...entities.values()].filter((e) => e.status === "ready").length,
    fromCache,
    excluded: excluded.length,
  });
  return { record, fromCache };
}

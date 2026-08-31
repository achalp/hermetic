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
import { enforceSameHost } from "./same-host";
import { ManifestError, MAX_MANIFEST_BYTES, MANIFEST_EAGER_BUDGET_MS } from "./shared";
import type { EntityState, ManifestRecord, ManifestStore } from "./store";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
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
  const parsed = parseDatasetManifestText(text, args.url);

  const { kept, excluded } = enforceSameHost(parsed);
  if (kept.length === 0) {
    // Fail CLOSED (spec §5.3): every entity pointed off-host. Name the policy
    // so a legitimate publisher understands what to change.
    throw new ManifestError(
      `Every entity in this manifest lives on a different host than the manifest ` +
        `itself (${excluded.length} excluded). Hermetic only reads entities from the ` +
        `manifest's own host.`
    );
  }
  if (excluded.length > 0) {
    logger.warn("Manifest connect: cross-host entities excluded", {
      manifestUrl: args.url,
      excluded: excluded.length,
    });
  }
  const manifest: DatasetManifest = { ...parsed, entities: kept };

  // Normalize each entity URL once (glob/hive detection) — the SAME normalizer
  // the single-URL dialog uses, so behavior cannot fork between the two doors.
  const targets = new Map<string, EntityTarget>(
    kept.map((e) => {
      const norm = normalizeRemoteParquetUrl(e.url);
      return [
        e.name,
        {
          name: e.name,
          readUrl: norm.readUrl,
          isHivePartitioned: Boolean(e.isHivePartitioned || norm.isHivePartitioned),
          ...(e.sha256 ? { sha256: e.sha256 } : {}),
        },
      ];
    })
  );

  const entities = new Map<string, EntityState>();
  const ready = (entity: ManifestEntity, schema: CSVSchema, csvId: string): EntityState => ({
    entity,
    status: "ready",
    csvId,
    rowCount: schema.row_count,
    columnCount: schema.columns.length,
  });

  // 1. Cache pass — a reconnect (or a restart) should be cache hits, not
  //    containers. `force` skips it and re-extracts everything eagerly reachable.
  let fromCache = 0;
  const misses: EntityTarget[] = [];
  for (const e of kept) {
    const t = targets.get(e.name)!;
    const cached = args.force
      ? null
      : await deps.readCachedSchema(
          entitySourceKey(t.readUrl, args.creds),
          entityFingerprint(e, manifestHash)
        );
    if (cached) {
      const csvId = deps.newId();
      const schema = { ...cached, csv_id: csvId, filename: e.name };
      deps.registerEntity(csvId, schema, t.readUrl, args.creds, t.isHivePartitioned);
      entities.set(e.name, ready(e, schema, csvId));
      fromCache++;
    } else {
      misses.push(t);
    }
  }

  // 2. Eager pass, inside the budget. Only where the docker extractor exists —
  //    on the built-in runtime every miss stays pending and the client drives
  //    the existing per-entity two-hop extraction on first touch (P3 upgrades this).
  let skipped: string[] = misses.map((t) => t.name);
  if (misses.length > 0 && deps.eagerCapable()) {
    const outcome = await deps.extractBatch(misses, args.creds, MANIFEST_EAGER_BUDGET_MS);
    skipped = outcome.skipped;
    for (const t of misses) {
      const r = outcome.results.get(t.name);
      if (!r) continue;
      const e = kept.find((k) => k.name === t.name)!;
      if ("schema" in r) {
        const csvId = deps.newId();
        const schema = { ...r.schema, csv_id: csvId, filename: e.name };
        deps.registerEntity(csvId, schema, t.readUrl, args.creds, t.isHivePartitioned);
        entities.set(t.name, ready(e, schema, csvId));
        await deps
          .writeCachedSchema(
            entitySourceKey(t.readUrl, args.creds),
            entityFingerprint(e, manifestHash),
            r.schema
          )
          .catch(() => {}); // cache write is never fatal
      } else {
        entities.set(t.name, { entity: e, status: "failed", error: r.error });
      }
    }
  }
  for (const name of skipped) {
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

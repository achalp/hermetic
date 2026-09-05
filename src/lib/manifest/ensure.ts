/**
 * Make specific manifest entities READY on the server (spec §6 MCP parity).
 *
 * The web app never needed this: its client drives lazy extraction entity by
 * entity (extract → `/api/manifest/attach`). MCP has no client — a host asks a
 * question and the server must materialize whatever entities the question
 * needs, on its own. This is that seam.
 *
 * It reuses the connect flow's EXACT semantics (same cache key, same
 * fingerprint, same batch extractor, same registration) rather than a second
 * implementation, because a divergence here would be invisible: entities would
 * still resolve, just with a different cache line or a different stored ref,
 * and only show up as a cache that never hits or a question reading the wrong
 * source. `connectDatasetManifest` calls this too, so there is ONE path.
 */
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { ManifestEntity } from "@/lib/contracts/dataset-manifest";
import type { EntityState, ManifestRecord } from "./store";
import {
  entitySourceKey,
  entityFingerprint,
  type EntityTarget,
  type BatchOutcome,
} from "./connect";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { logger, errMessage } from "@/lib/logger";

/** The subset of connect's deps this needs (same shapes, same meanings). */
export interface MaterializeDeps {
  readCachedSchema(sourceKey: string, fingerprint: string): Promise<CSVSchema | null>;
  writeCachedSchema(sourceKey: string, fingerprint: string, schema: CSVSchema): Promise<void>;
  extractBatch(
    targets: EntityTarget[],
    creds: RemoteCreds | undefined,
    budgetMs: number
  ): Promise<BatchOutcome>;
  registerEntity(
    csvId: string,
    schema: CSVSchema,
    readUrl: string,
    creds: RemoteCreds | undefined,
    isHivePartitioned: boolean
  ): void;
  newId(): string;
}

/** The read target for one entity — the SAME normalizer the single-URL door uses. */
export function targetFor(entity: ManifestEntity): EntityTarget {
  const norm = normalizeRemoteParquetUrl(entity.url);
  return {
    name: entity.name,
    readUrl: norm.readUrl,
    isHivePartitioned: Boolean(entity.isHivePartitioned || norm.isHivePartitioned),
    ...(entity.sha256 ? { sha256: entity.sha256 } : {}),
  };
}

function readyState(entity: ManifestEntity, schema: CSVSchema, csvId: string): EntityState {
  return {
    entity,
    status: "ready",
    csvId,
    rowCount: schema.row_count,
    columnCount: schema.columns.length,
  };
}

export interface MaterializeResult {
  /** Entity name → state, for every entity attempted. */
  states: Map<string, EntityState>;
  /** Cache hits (no extraction). */
  fromCache: number;
  /** Names the budget never reached — they stay PENDING, not failed. */
  skipped: string[];
}

/**
 * Cache-pass then extract: the two-step connect has always done, factored out
 * so lazy per-question materialization cannot drift from eager connect-time
 * materialization.
 *
 * `force` skips the cache. Entities the budget does not reach come back in
 * `skipped` and must be recorded PENDING by the caller — a budget miss is not
 * a failure, and marking it one would make a retry impossible.
 */
export async function materializeEntities(args: {
  entities: ManifestEntity[];
  manifestHash: string;
  creds?: RemoteCreds;
  deps: MaterializeDeps;
  budgetMs: number;
  force?: boolean;
  /** False on runtimes with no batch extractor — everything stays pending. */
  eagerCapable: boolean;
}): Promise<MaterializeResult> {
  const states = new Map<string, EntityState>();
  const targets = new Map(args.entities.map((e) => [e.name, targetFor(e)]));

  let fromCache = 0;
  const misses: EntityTarget[] = [];
  for (const e of args.entities) {
    const t = targets.get(e.name)!;
    const cached = args.force
      ? null
      : await args.deps.readCachedSchema(
          entitySourceKey(t.readUrl, args.creds),
          entityFingerprint(e, args.manifestHash)
        );
    if (cached) {
      const csvId = args.deps.newId();
      const schema = { ...cached, csv_id: csvId, filename: e.name };
      args.deps.registerEntity(csvId, schema, t.readUrl, args.creds, t.isHivePartitioned);
      states.set(e.name, readyState(e, schema, csvId));
      fromCache++;
    } else {
      misses.push(t);
    }
  }

  let skipped: string[] = misses.map((t) => t.name);
  if (misses.length > 0 && args.eagerCapable) {
    const outcome = await args.deps.extractBatch(misses, args.creds, args.budgetMs);
    skipped = outcome.skipped;
    for (const t of misses) {
      const r = outcome.results.get(t.name);
      if (!r) continue;
      const e = args.entities.find((k) => k.name === t.name)!;
      if ("schema" in r) {
        const csvId = args.deps.newId();
        const schema = { ...r.schema, csv_id: csvId, filename: e.name };
        args.deps.registerEntity(csvId, schema, t.readUrl, args.creds, t.isHivePartitioned);
        states.set(t.name, readyState(e, schema, csvId));
        await args.deps
          .writeCachedSchema(
            entitySourceKey(t.readUrl, args.creds),
            entityFingerprint(e, args.manifestHash),
            r.schema
          )
          .catch(() => {}); // a cache write is never fatal
      } else {
        states.set(t.name, { entity: e, status: "failed", error: r.error });
      }
    }
  }
  return { states, fromCache, skipped };
}

/**
 * Ensure the NAMED entities of an already-connected manifest are ready,
 * mutating the record in place. Already-ready entities are untouched (no
 * re-extraction, no new csvId — the id is a live handle the pipeline holds).
 *
 * Returns what the caller can actually use: ready names with their csvIds, and
 * the ones that could not be made ready with a reason. It never throws for a
 * per-entity failure — one unreadable entity must not sink a question that can
 * still be answered from the others.
 */
export async function ensureManifestEntities(args: {
  record: ManifestRecord;
  names: string[];
  deps: MaterializeDeps;
  budgetMs: number;
  eagerCapable: boolean;
  /**
   * Per-entity extractor for runtimes with NO batch extractor (wasm). The web
   * app never needs this — its client drives per-entity extraction on first
   * touch — but MCP has no client, so without it a manifest on the built-in
   * runtime would stay pending forever. Used only when `eagerCapable` is
   * false; a throw marks that one entity failed, never the batch.
   */
  extractOne?: (
    target: EntityTarget,
    creds: RemoteCreds | undefined,
    csvId: string,
    filename: string
  ) => Promise<CSVSchema>;
}): Promise<{
  ready: { name: string; csvId: string }[];
  unavailable: { name: string; reason: string }[];
}> {
  const ready: { name: string; csvId: string }[] = [];
  const unavailable: { name: string; reason: string }[] = [];
  const todo: ManifestEntity[] = [];

  for (const name of args.names) {
    const state = args.record.entities.get(name);
    if (!state) {
      unavailable.push({ name, reason: "not an entity of this manifest" });
      continue;
    }
    if (state.status === "ready" && state.csvId) {
      ready.push({ name, csvId: state.csvId });
      continue;
    }
    todo.push(state.entity);
  }

  if (todo.length > 0) {
    const { states, skipped } = await materializeEntities({
      entities: todo,
      manifestHash: args.record.manifestHash,
      ...(args.record.creds ? { creds: args.record.creds } : {}),
      deps: args.deps,
      budgetMs: args.budgetMs,
      eagerCapable: args.eagerCapable,
    });

    // Fallback pass: sequentially extract what the (absent) batch extractor
    // could not — SAME cache key, fingerprint and registration as the batch
    // path, so a later docker session hits the cache these writes fill.
    if (!args.eagerCapable && args.extractOne) {
      for (const name of skipped) {
        const e = todo.find((k) => k.name === name)!;
        const t = targetFor(e);
        const csvId = args.deps.newId();
        try {
          const extracted = await args.extractOne(t, args.record.creds, csvId, e.name);
          const schema = { ...extracted, csv_id: csvId, filename: e.name };
          args.deps.registerEntity(
            csvId,
            schema,
            t.readUrl,
            args.record.creds,
            t.isHivePartitioned
          );
          states.set(name, readyState(e, schema, csvId));
          await args.deps
            .writeCachedSchema(
              entitySourceKey(t.readUrl, args.record.creds),
              entityFingerprint(e, args.record.manifestHash),
              extracted
            )
            .catch(() => {});
        } catch (err) {
          states.set(name, { entity: e, status: "failed", error: errMessage(err) });
        }
      }
    }

    for (const [name, state] of states) {
      args.record.entities.set(name, state);
      if (state.status === "ready" && state.csvId) ready.push({ name, csvId: state.csvId });
      else unavailable.push({ name, reason: state.error ?? "could not be read" });
    }
    for (const name of skipped) {
      // Budget exhaustion leaves it PENDING (retryable), never "failed".
      if (!states.has(name)) {
        unavailable.push({ name, reason: "introspection budget exhausted — retry" });
      }
    }
    logger.info("Manifest: ensured entities on demand", {
      manifestId: args.record.manifestId,
      requested: args.names.length,
      ready: ready.length,
    });
  }
  return { ready, unavailable };
}

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
    budgetMs: number,
    onProgress?: (evt: import("@/lib/manifest/shared").ConnectProgress) => void
  ): Promise<BatchOutcome>;
  registerEntity(
    csvId: string,
    schema: CSVSchema,
    readUrl: string,
    creds: RemoteCreds | undefined,
    isHivePartitioned: boolean
  ): void;
  newId(): string;
  /**
   * Short-lived memory of entities whose extraction FAILED, so a slow failure
   * does not re-burn the connect budget its siblings need. INJECTED like every
   * other I/O here: reaching for disk directly from this pure materializer
   * made it read global state in tests (and would in any embedder).
   * Optional — absent means "no memory", the pre-existing behavior.
   */
  /**
   * DESCRIBE-only read: names, types, footer row count, no row egress. The
   * INCLUSION FLOOR — when a value profile fails, an entity whose schema can
   * still be read stays usable instead of being dropped from the question.
   * Optional: absent means a failed profile is simply a failure (the old
   * behavior), which is what the run-c4f47e34 drop looked like.
   */
  describeOne?(
    target: EntityTarget,
    creds: RemoteCreds | undefined,
    csvId: string,
    filename: string
  ): Promise<CSVSchema>;
  recentFailure?(sourceKey: string, fingerprint: string): Promise<string | null>;
  rememberFailure?(sourceKey: string, fingerprint: string, reason: string): Promise<void>;
  clearFailure?(sourceKey: string): Promise<void>;
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
  onProgress?: (evt: import("@/lib/manifest/shared").ConnectProgress) => void;
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
      args.onProgress?.({ phase: "extracted", entity: e.name, ok: true, cached: true });
      continue;
    }
    // A recently-FAILED entity is left pending instead of re-attempted: its
    // slow failure would consume the batch budget its siblings need (observed:
    // one entity failing at ~90s against a 60s budget skipped 13 others on
    // every connect). `force` — the user's explicit retry — skips this check.
    const failed =
      args.force || !args.deps.recentFailure
        ? null
        : await args.deps
            .recentFailure(
              entitySourceKey(t.readUrl, args.creds),
              entityFingerprint(e, args.manifestHash)
            )
            .catch(() => null);
    if (failed) {
      states.set(e.name, { entity: e, status: "failed", error: failed });
      args.onProgress?.({ phase: "extracted", entity: e.name, ok: false });
      continue;
    }
    misses.push(t);
  }

  let skipped: string[] = misses.map((t) => t.name);
  if (misses.length > 0 && args.eagerCapable) {
    const outcome = await args.deps.extractBatch(
      misses,
      args.creds,
      args.budgetMs,
      args.onProgress
    );
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
        // A success clears any remembered failure for this entity.
        void args.deps.clearFailure?.(entitySourceKey(t.readUrl, args.creds)).catch(() => {});
      } else {
        states.set(t.name, { entity: e, status: "failed", error: r.error });
        // Remember it so the NEXT connect spends its budget on entities that
        // can succeed, rather than re-burning it here (cooldown-limited).
        //
        // A TIMEOUT is NOT remembered: it means "too slow for this budget",
        // not "broken" — the entity may extract fine with a warm cache, less
        // contention, or a bigger budget. Remembering it would turn a slow
        // entity into a permanently-skipped one (a false negative this very
        // mechanism introduced when the per-entity floor was too tight).
        const isTimeout = /timed out|timeout/i.test(r.error);
        if (!isTimeout)
          void args.deps
            .rememberFailure?.(
              entitySourceKey(t.readUrl, args.creds),
              entityFingerprint(e, args.manifestHash),
              r.error
            )
            .catch(() => {});
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

    // DESCRIBE FLOOR: anything still not ready gets one cheap metadata read
    // before being declared unavailable. Statistics improve plans; they are not a
    // precondition for access, and dropping a table because its VALUES could not
    // be summarized is how a question silently loses a table it needs.
    if (args.deps.describeOne) {
      for (const [name, state] of states) {
        if (state.status === "ready" && state.csvId) continue;
        const t = targetFor(state.entity);
        const csvId = args.deps.newId();
        try {
          const described = await args.deps.describeOne(t, args.record.creds, csvId, name);
          const schema = { ...described, csv_id: csvId, filename: name };
          args.deps.registerEntity(
            csvId,
            schema,
            t.readUrl,
            args.record.creds,
            t.isHivePartitioned
          );
          // NOT written to the schema cache: a describe-only artifact under the
          // profile's key would read as a successful profile forever and block
          // the upgrade (same rule as the remote-parquet route).
          states.set(name, readyState(state.entity, schema, csvId));
        } catch {
          // Even the schema could not be read — the source really is unusable.
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

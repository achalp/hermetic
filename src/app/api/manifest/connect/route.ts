import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { parseBody, ManifestConnectBody } from "@/lib/api-schemas";
import { connectDatasetManifest } from "@/lib/manifest/connect";
import { fetchManifestText } from "@/lib/manifest/fetch";
import { getManifestStore } from "@/lib/manifest/store";
import { manifestView } from "@/lib/manifest/view";
import { extractRemoteParquetSchemaBatch } from "@/lib/parquet/schema-extractor";
import { readSchemaCache, writeSchemaCache } from "@/lib/schema-cache";
import { healSchemaColumnMeta } from "@/lib/csv/schema-heal";
import { recentFailure, rememberFailure, clearFailure } from "@/lib/manifest/failure-memory";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import { recordRecentSource, manifestHostName } from "@/lib/sources/recent-sources";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import { apiError } from "@/app/lib/api-error";

/**
 * Connect a dataset MANIFEST (spec §5): fetch through the egress core, adapt,
 * gate to the manifest's own host, then LIST it — profiling is on demand (see
 * eagerCapable below), so every entity without a cached schema stays pending
 * until a question needs it or the user profiles it. Returns the entity-list
 * view the browser renders; per-entity detail is
 * `GET /api/manifest/[id]?entity=…`.
 */
export const maxDuration = 300; // a deep STAC catalog is many document fetches

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const parsed = parseBody(ManifestConnectBody, await request.json());
    if (!parsed.ok) return parsed.response;
    const { url, creds, force } = parsed.data;

    // Stream connect progress as NDJSON so a deep STAC traversal (many document
    // fetches through the egress core) shows what the server is doing, then a
    // final {type:"result"} line carries the view. The client
    // (connectManifest) reads the stream; a non-streaming reader still gets the
    // result line last.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (obj: unknown) => {
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            /* client hung up — connect still runs to completion server-side */
          }
        };
        try {
          const { record } = await runConnect(url, creds, force, (evt) =>
            emit({ type: "progress", ...evt })
          );
          recordRecentSource({
            kind: "manifest",
            name: manifestHostName(url),
            subtitle: url,
            url,
            ...(creds ? { creds } : {}),
          }).catch(() => {});
          emit({ type: "result", view: manifestView(record) });
        } catch (err) {
          emit({
            type: "error",
            error: err instanceof Error ? err.message : "Failed to read that manifest",
          });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return apiError("/api/manifest/connect", err, "Failed to read that manifest");
  }
}

function runConnect(
  url: string,
  creds: RemoteCreds | undefined,
  force: boolean | undefined,
  onProgress: (evt: import("@/lib/manifest/shared").ConnectProgress) => void
) {
  return connectDatasetManifest(
    { url: url.trim(), ...(creds ? { creds } : {}), ...(force ? { force } : {}) },
    {
      fetchManifestText,
      readCachedSchema: async (sourceKey, fingerprint) => {
        const entry = await readSchemaCache<CSVSchema>(sourceKey);
        return entry && entry.fingerprint === fingerprint ? entry.artifact : null;
      },
      writeCachedSchema: (sourceKey, fingerprint, schema) =>
        writeSchemaCache(sourceKey, fingerprint, schema),
      extractBatch: (targets, batchCreds, budgetMs, onBatchProgress) =>
        extractRemoteParquetSchemaBatch(targets, batchCreds, budgetMs, onBatchProgress),
      registerEntity: (csvId, schema, readUrl, entityCreds, isHive) =>
        storeRemoteParquetRef(csvId, schema, readUrl, entityCreds, isHive),
      // TWO-TIER: connect never PROFILES. It lists the catalog and does the
      // free cache pass (entities profiled in an earlier session arrive
      // ready); the 500k-row value profile — ~50s of egress per entity,
      // measured — happens only when an analysis needs the entity or the user
      // asks for it explicitly. MCP is unaffected: it profiles through
      // ensureManifestEntities when a question needs an entity.
      eagerCapable: () => false,
      // Failure memory (disk-backed): a slow-failing entity is not
      // re-attempted next connect, so the budget goes to entities that can
      // actually succeed. Injected here, the composition root.
      recentFailure,
      rememberFailure,
      clearFailure,
      store: getManifestStore(),
      newId: () => randomUUID(),
      now: () => Date.now(),
    },
    onProgress
  );
}

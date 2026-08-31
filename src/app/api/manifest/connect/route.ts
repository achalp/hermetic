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
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { recordRecentSource, manifestHostName } from "@/lib/sources/recent-sources";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import { apiError } from "@/app/lib/api-error";

/**
 * Connect a dataset MANIFEST (spec §5): fetch through the egress core, adapt,
 * gate to the manifest's own host, then introspect eagerly inside the 60 s
 * budget (docker) — the rest stays pending for lazy extraction on first touch.
 * Returns the entity-list view the browser renders; per-entity detail is
 * `GET /api/manifest/[id]?entity=…`.
 */
export const maxDuration = 300; // eager introspection reads remote footers

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const parsed = parseBody(ManifestConnectBody, await request.json());
    if (!parsed.ok) return parsed.response;
    const { url, creds, force } = parsed.data;

    const { record } = await connectDatasetManifest(
      { url: url.trim(), ...(creds ? { creds } : {}), ...(force ? { force } : {}) },
      {
        fetchManifestText,
        readCachedSchema: async (sourceKey, fingerprint) => {
          const entry = await readSchemaCache<CSVSchema>(sourceKey);
          return entry && entry.fingerprint === fingerprint ? entry.artifact : null;
        },
        writeCachedSchema: (sourceKey, fingerprint, schema) =>
          writeSchemaCache(sourceKey, fingerprint, schema),
        extractBatch: (targets, batchCreds, budgetMs) =>
          extractRemoteParquetSchemaBatch(targets, batchCreds, budgetMs),
        registerEntity: (csvId, schema, readUrl, entityCreds, isHive) =>
          storeRemoteParquetRef(csvId, schema, readUrl, entityCreds, isHive),
        eagerCapable: () => getActiveSandboxRuntime() === "docker",
        store: getManifestStore(),
        newId: () => randomUUID(),
        now: () => Date.now(),
      }
    );

    // Recent-sources: first-class manifest kind, NAMED BY THE HOST (author
    // decision) — the url re-opens through the dialog's .json detection. No
    // `rows`: the UI renders that field as "N rows", which would misread the
    // entity count.
    recordRecentSource({
      kind: "manifest",
      name: manifestHostName(url),
      subtitle: url,
      url,
      creds,
    }).catch(() => {});

    return NextResponse.json(manifestView(record));
  } catch (err) {
    return apiError("/api/manifest/connect", err, "Failed to read that manifest");
  }
}

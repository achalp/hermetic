import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { validateLocalOrigin } from "@/lib/local-files/security";
import {
  extractRemoteParquetSchema,
  computeRemoteParquetFingerprint,
} from "@/lib/parquet/schema-extractor";
import { isSafeParquetUrl } from "@/lib/parquet/duckdb-source";
import { resolveWithCache } from "@/lib/schema-cache";
import { parseBody, RemoteParquetSchemaBody } from "@/lib/api-schemas";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { recordRecentSource } from "@/lib/sources/recent-sources";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import { apiError } from "@/lib/api-error";

export const maxDuration = 300; // remote reads over the network can be slow

/** A human filename from a Parquet URL: the last path segment, or the host. */
function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url.replace(/^s3:\/\//i, "https://").replace(/^gs:\/\//i, "https://"));
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || u.hostname;
  } catch {
    return url.split("/").filter(Boolean).pop() || url;
  }
}

export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  try {
    const parsedBody = parseBody(RemoteParquetSchemaBody, await request.json());
    if (!parsedBody.ok) return parsedBody.response;
    const url = parsedBody.data.url.trim();

    if (!isSafeParquetUrl(url)) {
      return NextResponse.json(
        { error: "Enter a valid s3:// or https:// Parquet URL (no quotes or special characters)." },
        { status: 400 }
      );
    }

    // zod already whitelists the recognized credential fields (extras are
    // stripped) and guarantees they're strings.
    const creds: RemoteCreds | undefined = parsedBody.data.creds;

    // Apply layout conventions: a bare folder/prefix (e.g. an Overture
    // theme=…/type=… path) becomes a recursive Parquet glob; Hive partitioning
    // is inferred from key=value segments. A single-file URL passes through.
    const { readUrl, isHivePartitioned } = normalizeRemoteParquetUrl(url);

    const runtime = getActiveSandboxRuntime();
    const csvId = uuidv4();
    const filename = filenameFromUrl(url);

    // Cache the (expensive, ~27s) extraction keyed by the source URL+creds, gated
    // on a cheap file-listing fingerprint (see schema-cache.ts). `force` is the
    // "ignore cache / re-read" control. The csvId/source_type differ per call, so
    // cache only the intrinsic schema and re-stamp csv_id on the returned copy.
    const sourceKey = `parquet:${readUrl}:${JSON.stringify(creds ?? {})}`;
    const { artifact: cachedSchema, status } = await resolveWithCache({
      sourceKey,
      force: parsedBody.data.force,
      fingerprint: () => computeRemoteParquetFingerprint(readUrl, runtime, creds),
      extract: () =>
        extractRemoteParquetSchema(readUrl, csvId, filename, runtime, isHivePartitioned, creds),
    });
    // Re-stamp per-request identity onto the (possibly cached) schema.
    const schema = { ...cachedSchema, csv_id: csvId, filename };
    storeRemoteParquetRef(csvId, schema, readUrl, creds, isHivePartitioned);

    // Remember it so the user never re-pastes this URL (see recent-sources.ts).
    recordRecentSource({
      kind: "remote-parquet",
      name: filename,
      subtitle: url,
      rows: schema.row_count,
      url,
      creds,
      isHivePartitioned,
    }).catch(() => {});

    return NextResponse.json({ csv_id: csvId, schema, cache_status: status });
  } catch (err) {
    return apiError("/api/remote-parquet/schema", err, "Failed to read remote Parquet");
  }
}

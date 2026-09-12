import { NextResponse } from "next/server";
import { healSchemaColumnMeta } from "@/lib/csv/schema-heal";
import { v4 as uuidv4 } from "uuid";
import { validateLocalOrigin } from "@/lib/local-files/security";
import {
  extractRemoteParquetSchema,
  describeRemoteParquet,
  computeRemoteParquetFingerprint,
} from "@/lib/parquet/schema-extractor";
import { profileSatisfiesDepth } from "@/lib/parquet/profile-depth";
import { logger, errMessage } from "@/lib/logger";
import { isSafeParquetUrl } from "@/lib/parquet/duckdb-source";
import { resolveWithCache, readWasmSchemaCache } from "@/lib/schema-cache";
import { prepareWasmRemoteSchemaJob } from "@/lib/parquet/wasm-schema-job";
import { getWasmSchemaLeaseStore } from "@/lib/parquet/wasm-schema-lease-store";
import { parseBody, RemoteParquetSchemaBody } from "@/lib/api-schemas";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { getActiveSandboxRuntime, getProfileDepth } from "@/lib/runtime-config";
import { recordRecentSource } from "@/lib/sources/recent-sources";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import { apiError } from "@/app/lib/api-error";

// A value profile is bandwidth-bound: no wall clock bounds it correctly (60s
// starved a catalog, 120s lost division_area twice). The ceiling here exists only
// so a wedged request cannot live forever; cancellation is the user's Stop, which
// arrives as request.signal below.
export const maxDuration = 3600;

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

/** Remember the source so the user never re-pastes this URL (recent-sources.ts). */
function recordRemote(
  schema: { row_count: number },
  url: string,
  name: string,
  creds: RemoteCreds | undefined,
  isHivePartitioned: boolean
): void {
  recordRecentSource({
    kind: "remote-parquet",
    name,
    subtitle: url,
    rows: schema.row_count,
    url,
    creds,
    isHivePartitioned,
  }).catch(() => {});
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

    // ── The built-in (wasm) runtime: extract in the WORKER, in two hops ──
    // There is no container to run synchronously and no stream to push a job
    // into, but connect is user-initiated, so the browser already owns a worker.
    // Hop 1 (here) checks the cache and, on a miss, hands back a prepared job;
    // hop 2 (/complete) turns its envelope into a schema. See D24/D27.
    if (runtime !== "docker") {
      const cached = await readWasmSchemaCache<CSVSchema>({
        sourceKey,
        force: parsedBody.data.force,
        fingerprint: () => computeRemoteParquetFingerprint(readUrl, runtime, creds),
      });
      if (cached) {
        // Heal on READ: an entry written by an older build can carry a null
        // column meta, and every consumer switches on meta.kind.
        const schema = healSchemaColumnMeta({ ...cached, csv_id: csvId, filename });
        storeRemoteParquetRef(csvId, schema, readUrl, creds, isHivePartitioned);
        recordRemote(schema, url, filename, creds, isHivePartitioned);
        return NextResponse.json({ csv_id: csvId, schema, cache_status: "hit" });
      }
      const { job, lease } = await prepareWasmRemoteSchemaJob({
        readUrl,
        csvId,
        filename,
        sourceKey,
        ...(creds ? { creds } : {}),
        isHivePartitioned,
      });
      getWasmSchemaLeaseStore().sweep();
      getWasmSchemaLeaseStore().put(lease);
      // Not a schema yet: the client must run `job` and POST the envelope back.
      return NextResponse.json({ needs_worker: true, job });
    }

    let cachedSchema: CSVSchema;
    let status: string;
    let tier: "profiled" | "described" = "profiled";
    // Read OUTSIDE the try: the fallback below exists for a failed remote READ,
    // and must not also swallow a local programming error by quietly serving a
    // describe-only schema (it did exactly that when a test's config mock lacked
    // this function — a silent degradation is worse than the crash it hides).
    const depth = getProfileDepth();
    try {
      const resolved = await resolveWithCache({
        sourceKey,
        force: parsedBody.data.force,
        fingerprint: () => computeRemoteParquetFingerprint(readUrl, runtime, creds),
        extract: () =>
          // The REQUEST's signal is the Stop: when the browser aborts (user
          // stopped, navigated, closed the tab) the container work stops with it
          // instead of profiling on for nobody with an egress network held open.
          extractRemoteParquetSchema(
            readUrl,
            csvId,
            filename,
            runtime,
            isHivePartitioned,
            creds,
            request.signal
          ),
        // Depth is a REUSE gate, not part of the source identity: the source did
        // not change when the user raised the setting, but a 50k profile can no
        // longer answer a 500k request. See profileSatisfiesDepth for the three
        // cases that make this subtler than an equality check.
        accept: (artifact) => profileSatisfiesDepth(artifact.profile_basis, depth),
      });
      cachedSchema = resolved.artifact;
      status = resolved.status;
    } catch (profileErr) {
      // PROFILE FAILED — do not lose the table. A value profile egresses rows
      // and its duration scales with the dataset and the user's bandwidth, so it
      // fails for reasons that say nothing about whether the source is USABLE:
      // Overture division_area failed twice at ~2.1min while the query that
      // answered the question read its bbox/names columns happily.
      //
      // Fall back to the DESCRIBE floor: names, types, footer row count, no row
      // egress. Columns come back marked `unprofiled`, which the prompt states
      // per column, so the model is told what is unknown rather than guessing.
      logger.warn("Remote Parquet profile failed — falling back to DESCRIBE", {
        filename,
        error: errMessage(profileErr),
      });
      // Deliberately NOT cached: a describe-only artifact stored under the
      // profile's cache key would read as a successful profile forever and block
      // the upgrade. It costs seconds to redo, so recompute beats poisoning.
      cachedSchema = await describeRemoteParquet(
        readUrl,
        csvId,
        filename,
        runtime,
        isHivePartitioned,
        creds
      );
      status = "bypass";
      tier = "described";
    }
    // Re-stamp per-request identity onto the (possibly cached) schema, healing
    // any column meta an older build left null.
    const schema = healSchemaColumnMeta({ ...cachedSchema, csv_id: csvId, filename });
    storeRemoteParquetRef(csvId, schema, readUrl, creds, isHivePartitioned);

    recordRemote(schema, url, filename, creds, isHivePartitioned);

    return NextResponse.json({ csv_id: csvId, schema, cache_status: status, profile_tier: tier });
  } catch (err) {
    return apiError("/api/remote-parquet/schema", err, "Failed to read remote Parquet");
  }
}

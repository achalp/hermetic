import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { parseWasmSchemaEnvelope } from "@/lib/parquet/wasm-schema-job";
import { getWasmSchemaLeaseStore } from "@/lib/parquet/wasm-schema-lease-store";
import { getRangeRegistry } from "@/lib/sandbox/wasm/range-singleton";
import { writeSchemaCache } from "@/lib/schema-cache";
import { computeRemoteParquetFingerprintHost } from "@/lib/parquet/host-fingerprint";
import { storeRemoteParquetRef } from "@/lib/csv/storage";
import { recordRecentSource } from "@/lib/sources/recent-sources";
import { apiError } from "@/app/lib/api-error";
import { logger } from "@/lib/logger";

/**
 * Hop 2 of connect-time schema extraction on the built-in runtime (build log D27).
 * The browser ran the job it was handed by `/api/remote-parquet/schema` and POSTs
 * the worker's envelope here; this turns it into a stored schema.
 *
 * What the host keeps for itself, and does NOT take from this request: the source
 * URL, the credentials, the egress allowlist, the token budgets, and the lease —
 * all of those come from the lease table, keyed by an id the host itself issued.
 * The body contributes only the PROFILE, whose shape is validated before it is
 * stored. So a forged or replayed POST can at worst supply a wrong profile for a
 * connect the user already started; it cannot name a new source or revive a token.
 *
 * The range tokens are released here in a `finally`: they are capabilities, and the
 * lease TTL is a backstop, not the intended lifetime.
 */
export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  let releaseTokens: string[] = [];
  try {
    const body = (await request.json()) as {
      requestId?: unknown;
      envelope?: { exitCode?: unknown; output?: unknown; stderr?: unknown };
    };
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    if (!requestId || !body.envelope) {
      return NextResponse.json({ error: "requestId and envelope are required" }, { status: 400 });
    }

    // Single-use: an unknown, already-completed, or lapsed id is not a schema.
    const lease = getWasmSchemaLeaseStore().take(requestId);
    if (!lease) {
      return NextResponse.json({ error: "unknown or expired extraction" }, { status: 404 });
    }
    releaseTokens = lease.tokens;

    const schema = parseWasmSchemaEnvelope(
      {
        exitCode: Number(body.envelope.exitCode),
        output: body.envelope.output,
        ...(typeof body.envelope.stderr === "string" ? { stderr: body.envelope.stderr } : {}),
      },
      lease.csvId,
      lease.filename
    );

    storeRemoteParquetRef(lease.csvId, schema, lease.readUrl, lease.creds, lease.isHivePartitioned);

    // Cache under a FRESH fingerprint rather than one captured at hand-out time:
    // if the source changed while the worker profiled it, the entry must reflect
    // what was actually read, not what the listing looked like a minute ago.
    computeRemoteParquetFingerprintHost(lease.readUrl, lease.creds)
      .then((fp) => writeSchemaCache(lease.sourceKey, fp, schema))
      .catch((err) =>
        logger.warn("wasm schema cache write skipped", {
          error: String(err instanceof Error ? err.message : err),
        })
      );

    recordRecentSource({
      kind: "remote-parquet",
      name: lease.filename,
      subtitle: lease.readUrl,
      rows: schema.row_count,
      url: lease.readUrl,
      creds: lease.creds,
      isHivePartitioned: lease.isHivePartitioned,
    }).catch(() => {});

    logger.info("WASM connect: schema extracted in worker", {
      csvId: lease.csvId,
      rows: schema.row_count,
      columns: schema.columns.length,
    });
    return NextResponse.json({ csv_id: lease.csvId, schema, cache_status: "miss" });
  } catch (err) {
    return apiError("/api/remote-parquet/schema/complete", err, "Failed to read remote Parquet");
  } finally {
    const registry = getRangeRegistry();
    for (const t of releaseTokens) registry.release(t);
  }
}

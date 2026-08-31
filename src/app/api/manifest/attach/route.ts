import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { parseBody, ManifestAttachBody } from "@/lib/api-schemas";
import { getManifestStore } from "@/lib/manifest/store";
import { entityDetail } from "@/lib/manifest/view";
import { getStoredCSV } from "@/lib/csv/storage";
import { normalizeRemoteParquetUrl } from "@/lib/parquet/partition";
import { apiError } from "@/app/lib/api-error";
import { logger } from "@/lib/logger";

/**
 * Attach a LAZILY-extracted entity back to its manifest (spec §5.5). The client
 * introspected a pending entity through the EXISTING per-entity flow
 * (`/api/remote-parquet/schema`, which already handles both runtimes including
 * the wasm two-hop) and reports the csvId here so the manifest store learns it
 * is ready.
 *
 * Trust: the body names ids, never data. The csvId must exist server-side AND
 * its stored remote URL must be exactly the entity's normalized URL — so a
 * client cannot bind entity "a" to some other source's csvId; it can only tell
 * us that the extraction we ourselves stored belongs to this entity.
 */
export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const parsed = parseBody(ManifestAttachBody, await request.json());
    if (!parsed.ok) return parsed.response;
    const { manifestId, name, csvId } = parsed.data;

    const store = getManifestStore();
    const record = store.get(manifestId);
    const state = record?.entities.get(name);
    if (!record || !state) {
      return NextResponse.json({ error: "unknown manifest or entity" }, { status: 404 });
    }
    const stored = getStoredCSV(csvId);
    if (!stored?.remoteParquetUrl) {
      return NextResponse.json({ error: "unknown csvId" }, { status: 404 });
    }
    const expected = normalizeRemoteParquetUrl(state.entity.url).readUrl;
    if (stored.remoteParquetUrl !== expected) {
      logger.warn("Manifest attach refused: csvId does not match the entity's URL", {
        manifestId,
        name,
      });
      return NextResponse.json({ error: "csvId does not belong to this entity" }, { status: 409 });
    }

    store.setEntityState(manifestId, name, {
      status: "ready",
      csvId,
      rowCount: stored.schema.row_count,
      columnCount: stored.schema.columns.length,
    });
    return NextResponse.json(entityDetail(record, name, (id) => getStoredCSV(id)?.schema));
  } catch (err) {
    return apiError("/api/manifest/attach", err, "Failed to attach entity");
  }
}

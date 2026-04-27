/**
 * dbt manifest binding endpoint.
 *
 * POST   /api/warehouse/dbt-metadata { warehouse_id, manifestPath }   → load + apply
 * DELETE /api/warehouse/dbt-metadata { warehouse_id }                 → clear binding
 *
 * Validates the path looks like a real `manifest.json`, parses it,
 * applies descriptions to the warehouse's stored table schemas, and
 * returns a count of enriched tables for UI feedback.
 */

import { setDbtManifestPath } from "@/lib/warehouse/storage";
import { validateManifestPath } from "@/lib/warehouse/dbt-metadata";
import { logger } from "@/lib/logger";

export async function POST(request: Request) {
  try {
    const { warehouse_id, manifestPath } = (await request.json()) as {
      warehouse_id?: string;
      manifestPath?: string;
    };

    if (!warehouse_id) {
      return Response.json({ error: "warehouse_id required" }, { status: 400 });
    }
    if (!manifestPath) {
      return Response.json({ error: "manifestPath required" }, { status: 400 });
    }

    const validation = await validateManifestPath(manifestPath);
    if (!validation.ok) {
      return Response.json({ error: validation.error }, { status: 400 });
    }

    const result = await setDbtManifestPath(warehouse_id, manifestPath);
    if (!result) {
      return Response.json({ error: "warehouse not found" }, { status: 404 });
    }

    return Response.json({
      ok: true,
      manifestPath,
      enrichedTableCount: result.enrichedTableCount,
      totalTableCount: result.stored.tableSchemas.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load dbt manifest";
    logger.error("dbt manifest load failed", { error: msg });
    return Response.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { warehouse_id } = (await request.json()) as { warehouse_id?: string };
    if (!warehouse_id) {
      return Response.json({ error: "warehouse_id required" }, { status: 400 });
    }
    const result = await setDbtManifestPath(warehouse_id, null);
    if (!result) {
      return Response.json({ error: "warehouse not found" }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to clear dbt manifest";
    return Response.json({ error: msg }, { status: 500 });
  }
}

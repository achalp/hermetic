/**
 * Persist a user-authored notebook layout (markdown cells + cell ordering)
 * onto the cached investigation trail. Because the trail is part of
 * CachedArtifacts, the layout flows into history saves for free.
 */

import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { NotebookLayout, NotebookLayoutCell } from "@/lib/pipeline/investigation-trace";
import { logger } from "@/lib/logger";
import { apiError } from "@/lib/api-error";

export const maxDuration = 30;

/** Validate + normalize the incoming layout, dropping anything malformed. */
function sanitizeLayout(raw: unknown): NotebookLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const cellsRaw = (raw as { cells?: unknown }).cells;
  if (!Array.isArray(cellsRaw)) return null;
  const cells: NotebookLayoutCell[] = [];
  for (const c of cellsRaw) {
    if (!c || typeof c !== "object") continue;
    const cell = c as Record<string, unknown>;
    if (cell.kind === "step" && typeof cell.stepNo === "number") {
      cells.push({ kind: "step", stepNo: cell.stepNo });
    } else if (
      cell.kind === "markdown" &&
      typeof cell.id === "string" &&
      typeof cell.content === "string"
    ) {
      cells.push({ kind: "markdown", id: cell.id, content: cell.content.slice(0, 20000) });
    }
  }
  return { cells };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { csv_id?: string; layout?: unknown };
    if (!body.csv_id) {
      return Response.json({ error: "csv_id required" }, { status: 400 });
    }
    const layout = sanitizeLayout(body.layout);
    if (!layout) {
      return Response.json({ error: "invalid layout" }, { status: 400 });
    }

    const prior = getCachedArtifacts(body.csv_id);
    if (!prior?.investigation) {
      return Response.json(
        { error: "No investigation trail cached for this dataset (it may have expired)." },
        { status: 404 }
      );
    }

    // Mutate the shared trace ref and re-cache (refreshes TTL).
    prior.investigation.notebook = layout;
    cacheArtifacts(body.csv_id, prior);
    logger.info("Investigate: notebook layout saved", {
      csvId: body.csv_id,
      cells: layout.cells.length,
    });
    return Response.json({ ok: true });
  } catch (err) {
    return apiError("/api/query/investigate/notebook", err, "Save failed");
  }
}

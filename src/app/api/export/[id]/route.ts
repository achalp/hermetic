import { join } from "node:path";
import { apiError } from "@/app/lib/api-error";
import { loadHistoryEntry } from "@/lib/history/storage";
import { exportDashboardHtml, exportFilename } from "@/lib/export/html-export";

/**
 * GET /api/export/<history-id> — the persisted entry as ONE self-contained
 * interactive .html download (specs/dashboard-distribution-2026-08-05.md).
 *
 * Exists in the web harness so the MCP `export_url` stays valid when
 * `HERMETIC_MCP_VIEW_BASE` points links at the web app instead of the
 * embedded viewer: both bases serve the same path with the same semantics
 * (the embedded viewer's twin lives in src/mcp/viewer/server.ts). The
 * POST /api/export-html sibling serves the live (unsaved) spec from the
 * export menu; this one serves persisted entries by id.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Load first, assemble second: both throw ENOENT, but a missing ENTRY is a
  // 404 while missing export BUNDLES are a 503 with the build hint.
  let entry: Awaited<ReturnType<typeof loadHistoryEntry>>;
  try {
    entry = await loadHistoryEntry(id);
  } catch {
    return Response.json({ error: `No history entry ${id}` }, { status: 404 });
  }
  try {
    const { html, report } = await exportDashboardHtml({
      spec: entry.spec,
      question: entry.meta.question,
      createdAt: entry.meta.timestamp ? new Date(entry.meta.timestamp).toISOString() : null,
      distDir: join(process.cwd(), "src/mcp/viewer/dist"),
    });
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(entry.meta.question)}"`,
        "Cache-Control": "no-store",
        "X-Hermetic-Export-Bundle": report.bundle,
        "X-Hermetic-Export-Bytes": String(report.bytes),
      },
    });
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return Response.json(
        { error: "Export bundles are not built — run `pnpm mcp:build-viewer`, then retry." },
        { status: 503 }
      );
    }
    return apiError("/api/export/[id]", err, "Failed to export dashboard");
  }
}

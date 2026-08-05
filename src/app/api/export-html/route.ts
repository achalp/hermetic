/**
 * POST /api/export-html — the web surface of the single-file HTML export
 * (specs/dashboard-distribution-2026-08-05.md §4.2): the current dashboard
 * spec in, ONE self-contained .html out, as a browser download.
 *
 * Validation is deliberately shallow ({root, elements, state?} shape only):
 * the assembler is tolerant of unknown element types, and the live client
 * spec legitimately carries `__`-prefixed state keys — stripInternalState
 * removes them inside exportDashboardHtml, so the client sends as-is.
 */
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/app/lib/api-error";
import { readJsonBody, parseBody } from "@/lib/api-schemas";
import { exportDashboardHtml, exportFilename } from "@/lib/export/html-export";

const ExportHtmlBodySchema = z.object({
  spec: z.object({
    root: z.unknown(),
    elements: z.record(z.string(), z.unknown()),
    state: z.record(z.string(), z.unknown()).optional(),
  }),
  question: z.string().max(4000).nullish(),
  /** As-of watermark; the client sends "now" for a live dashboard. */
  created_at: z.string().max(64).nullish(),
});

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return body.response;
  const parsed = parseBody(ExportHtmlBodySchema, body.body);
  if (!parsed.ok) return parsed.response;
  const { spec, question, created_at } = parsed.data;

  try {
    const { html, report } = await exportDashboardHtml({
      spec,
      question: question ?? null,
      createdAt: created_at ?? null,
      // The lib owns no asset paths — each harness resolves the viewer build
      // output itself. Next runs with cwd = repo root (same assumption the
      // data root in lib/paths.ts already makes), so repo-relative works.
      distDir: join(process.cwd(), "src/mcp/viewer/dist"),
    });

    // The report rides in headers so the client can toast bundle/size while
    // the body stays the raw downloadable file (spec §5 size honesty).
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(question)}"`,
        "X-Hermetic-Export-Bundle": report.bundle,
        "X-Hermetic-Export-Bytes": String(report.bytes),
        "X-Hermetic-Export-Elements": String(report.elementCount),
        "X-Hermetic-Export-Full-Only": report.fullOnlyTypesUsed.join(","),
      },
    });
  } catch (err) {
    // ENOENT here means the viewer export bundles were never built — a setup
    // problem with a one-command fix, not a 500-worthy server fault.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return NextResponse.json(
        { error: "Viewer export bundles not built. Run `pnpm mcp:build-viewer`, then retry." },
        { status: 503 }
      );
    }
    return apiError("/api/export-html", err, "HTML export failed");
  }
}

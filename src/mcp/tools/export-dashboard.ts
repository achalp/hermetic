/**
 * export_dashboard — a persisted dashboard as ONE self-contained .html file
 * (specs/dashboard-distribution-2026-08-05.md §4.2, pillar: artifact).
 *
 * Spec, data, renderer, charts, themes, fonts — inlined by the shared
 * assembler (lib/export/html-export). The file opens from file://, offline,
 * forever: the agent hands the user something that travels beyond the
 * machine, which is the durable-artifact thesis made portable.
 *
 * The response carries BOTH handles the host can present: `file_path` (the
 * written file, for "attach/send this") and `export_url` (the embedded
 * viewer's download route, for "click to save"). Size honesty (spec §5)
 * rides along as bundle/size_bytes/full_only_types_used.
 */
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hermeticPaths } from "@/lib/paths";
import type { ExportInput } from "@/lib/export/html-export";
import type { McpDeps } from "../deps";
import { exportUrl } from "../view-url";
import { McpToolError } from "../errors";
import { withToolLog } from "./log";

/** The McpDeps slice export_dashboard consumes (see LivenessDeps for the pattern). */
export type ExportDashboardDeps = Pick<McpDeps, "loadHistoryEntry" | "exportDashboardHtml">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The viewer build output — the same dist the embedded viewer serves. */
const DIST = resolve(__dirname, "..", "viewer", "dist");

const EXPORT_BUILD_HELP =
  "The single-file export bundles are not built. Run `pnpm mcp:build-viewer` in the hermetic " +
  "checkout, then call export_dashboard again.";

export const exportDashboardInput = {
  history_id: z
    .string()
    .describe("The history_id returned by analyze or persist_dashboard (a UUID)."),
  out_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to write the .html file to. Default: data/exports/<history_id>.html " +
        "under the hermetic checkout."
    ),
};

export async function exportDashboard(
  deps: ExportDashboardDeps,
  args: { history_id: string; out_path?: string }
): Promise<Record<string, unknown>> {
  return withToolLog("export_dashboard", { history_id: args.history_id }, () =>
    exportDashboardImpl(deps, args)
  );
}

async function exportDashboardImpl(
  deps: ExportDashboardDeps,
  args: { history_id: string; out_path?: string }
): Promise<Record<string, unknown>> {
  if (!UUID_RE.test(args.history_id)) {
    throw new McpToolError(
      "invalid_input",
      `'${args.history_id}' is not a history_id. Pass the UUID analyze/persist_dashboard returned.`
    );
  }
  if (args.out_path !== undefined && !isAbsolute(args.out_path)) {
    throw new McpToolError("invalid_input", "out_path must be an absolute path.");
  }

  let entry: Awaited<ReturnType<ExportDashboardDeps["loadHistoryEntry"]>>;
  try {
    entry = await deps.loadHistoryEntry(args.history_id);
  } catch {
    throw new McpToolError(
      "invalid_input",
      `No history entry '${args.history_id}'. Use the history_id from an analyze or ` +
        "persist_dashboard response."
    );
  }

  const question = typeof entry.meta.question === "string" ? entry.meta.question : null;
  let assembled: Awaited<ReturnType<ExportDashboardDeps["exportDashboardHtml"]>>;
  try {
    assembled = await deps.exportDashboardHtml({
      // Persisted specs are {root, elements, state} on disk; the store types
      // them as an opaque record, so this narrows rather than converts.
      spec: entry.spec as ExportInput["spec"],
      question,
      createdAt:
        typeof entry.meta.timestamp === "number"
          ? new Date(entry.meta.timestamp).toISOString()
          : null,
      distDir: DIST,
    });
  } catch (err) {
    // The assembler only reads viewer-build files — an ENOENT there means
    // the export bundles are missing, not that this entry is broken.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new McpToolError("execution_failed", EXPORT_BUILD_HELP);
    }
    throw err;
  }

  // Lazy path resolution (the store rule): the harness may re-root paths
  // after module load, so the exports dir is derived per call.
  const filePath =
    args.out_path ?? join(hermeticPaths.dataDir(), "exports", `${args.history_id}.html`);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, assembled.html, "utf-8");

  return {
    history_id: args.history_id,
    file_path: filePath,
    export_url: exportUrl(args.history_id),
    bundle: assembled.report.bundle,
    size_bytes: assembled.report.bytes,
    element_count: assembled.report.elementCount,
    full_only_types_used: assembled.report.fullOnlyTypesUsed,
  };
}

/**
 * `hermetic render <history-id> --html <out-path>` — the CLI surface of the
 * single-file HTML export (specs/dashboard-distribution-2026-08-05.md §4.2;
 * docs/cli.md promised a render command since Phase 1).
 *
 * Compiles a persisted history entry (the spec + question + timestamp the
 * `ask` command saved) into ONE self-contained interactive .html via the same
 * framework-free assembler the web route and MCP server call. Report goes to
 * stderr in the CLI's `[tag]` style; stdout stays clean (same protocol
 * discipline as main.ts's NDJSON stream).
 *
 * Separate module from main.ts so the command's wiring is unit-testable —
 * main.ts runs its pipeline at import time.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const RENDER_USAGE = "usage: hermetic render <history-id> --html <out-path>";

/** Human size for the report line ("3.2 MB", "412 KB"). */
function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  return bytes >= MB
    ? `${(bytes / MB).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function runRenderCommand(args: string[]): Promise<number> {
  const htmlIdx = args.indexOf("--html");
  const outArg = htmlIdx >= 0 ? args[htmlIdx + 1] : undefined;
  const positional = htmlIdx >= 0 ? args.slice(0, htmlIdx) : args;
  const [historyId] = positional;
  if (!historyId || !outArg) {
    console.error(RENDER_USAGE);
    return 2;
  }

  // Same harness boot as `ask` — path roots and env snapshot must match the
  // run that persisted the entry, or the history lookup misses.
  const { installEnvConfig } = await import("@/harness/env-config");
  installEnvConfig("snapshot");

  // The lib owns no asset paths; each harness resolves the viewer build
  // output itself. The CLI runs from the repo checkout (docs/cli.md), so
  // repo-relative from cwd — same convention as main.ts's fixtures default.
  const distDir = resolve("src/mcp/viewer/dist");
  if (!existsSync(join(distDir, "export-manifest.json"))) {
    console.error(
      `[error] viewer export bundles not found in ${distDir} — run \`pnpm mcp:build-viewer\` first`
    );
    return 1;
  }

  const { loadHistoryEntry } = await import("@/lib/history/storage");
  let entry: Awaited<ReturnType<typeof loadHistoryEntry>>;
  try {
    entry = await loadHistoryEntry(historyId);
  } catch (err) {
    console.error(
      `[error] could not load history entry ${historyId}: ` +
        `${err instanceof Error ? err.message : err}` +
        ` (ids are printed by \`hermetic ask\` as "[history] saved <id>")`
    );
    return 1;
  }

  const { exportDashboardHtml } = await import("@/lib/export/html-export");
  const { html, report } = await exportDashboardHtml({
    spec: entry.spec,
    question: entry.meta.question,
    // HistoryMeta carries an epoch timestamp; the assembler wants the ISO
    // as-of watermark string.
    createdAt: new Date(entry.meta.timestamp).toISOString(),
    distDir,
  });

  const outPath = resolve(outArg);
  writeFileSync(outPath, html);
  // Size honesty (spec §5): print which bundle got inlined and why.
  const why =
    report.fullOnlyTypesUsed.length > 0 ? ` (uses ${report.fullOnlyTypesUsed.join(", ")})` : "";
  console.error(
    `[render] ${report.bundle} bundle${why}, ${report.elementCount} elements, ${formatBytes(report.bytes)}`
  );
  console.error(`[out] ${outPath}`);
  return 0;
}

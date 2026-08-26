/**
 * Single-file HTML export assembler
 * (specs/dashboard-distribution-2026-08-05.md): the dashboard IS the file.
 *
 * Takes a persisted spec (data already inline in its state — the same JSON
 * the embedded viewer renders) and emits ONE self-contained .html: spec +
 * manifest as inline JSON blocks, renderer + charts + themes + fonts as
 * inline JS/CSS from the prebuilt export profiles. No fetches, no chunks —
 * the file works from file://, offline, forever.
 *
 * Profile choice is size honesty (spec §5): STANDARD (core + nivo +
 * plotly-cartesian, ~3MB) unless the spec uses a heavy family
 * (gl3d/finance/polar/geo/globe — export-manifest.json's fullOnlyTypes),
 * then FULL (~11MB). The report says which and why, so size is never a
 * surprise.
 *
 * Framework-free lib: callable from the web route, the CLI, and the MCP
 * server. The caller supplies distDir (the viewer build output) because the
 * lib layer owns no asset paths.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExportInput {
  spec: { root?: unknown; elements?: Record<string, unknown>; state?: Record<string, unknown> };
  question?: string | null;
  /** Persisted-entry timestamp — the as-of watermark. */
  createdAt?: string | null;
  /** The viewer build output dir (src/mcp/viewer/dist). */
  distDir: string;
}

export interface ExportReport {
  bundle: "standard" | "full";
  bytes: number;
  elementCount: number;
  /** The types that forced FULL ([] when standard sufficed). */
  fullOnlyTypesUsed: string[];
}

interface ExportBuildManifest {
  fullOnlyTypes: string[];
  profiles: Record<"standard" | "full", { js: string; css: string; bytes: number }>;
}

/**
 * Inline `</script` inside a JSON block would terminate the surrounding tag
 * — the standard escape keeps the JSON parseable and the HTML intact.
 */
function jsonBlock(id: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/<\//g, "<\\/");
  return `<script type="application/json" id="${id}">${json}</script>`;
}

/**
 * Publish-governance floor (June spec §8, inherited): the exported spec
 * must not carry pipeline-internal state. `__`-prefixed state keys are the
 * wire protocol's private namespace (cost, run ids, progress, warehouse
 * internals) — none are needed to render, all are stripped. Datasets and
 * control state (unprefixed) stay: they ARE the Tier-2 interactivity.
 */
export function stripInternalState(
  spec: ExportInput["spec"]
): ExportInput["spec"] & { state?: Record<string, unknown> } {
  if (!spec.state) return spec;
  const state: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec.state)) {
    if (!k.startsWith("__")) state[k] = v;
  }
  return { ...spec, state };
}

export async function exportDashboardHtml(
  input: ExportInput
): Promise<{ html: string; report: ExportReport }> {
  const manifest = JSON.parse(
    await readFile(join(input.distDir, "export-manifest.json"), "utf-8")
  ) as ExportBuildManifest;

  const spec = stripInternalState(input.spec);
  const elements = Object.values(spec.elements ?? {});
  const types = new Set(
    elements
      .map((el) => (el as { type?: string }).type)
      .filter((t): t is string => typeof t === "string")
  );
  const fullOnlyTypesUsed = manifest.fullOnlyTypes.filter((t) => types.has(t)).sort();
  const bundle: "standard" | "full" = fullOnlyTypesUsed.length > 0 ? "full" : "standard";
  const profile = manifest.profiles[bundle];

  const [appCss, profileCss, profileJs] = await Promise.all([
    readFile(join(input.distDir, "export-app.css"), "utf-8"),
    readFile(join(input.distDir, profile.css), "utf-8").catch(() => ""),
    readFile(join(input.distDir, profile.js), "utf-8"),
  ]);

  const exportManifest = {
    question: input.question ?? null,
    createdAt: input.createdAt ?? null,
    generator: "hermetic",
    bundle,
    elementCount: elements.length,
  };

  const title = (input.question ?? "hermetic analysis").slice(0, 120);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<!-- Browser-safe process shim: the inlined bundle has a few unguarded reads
     of the Node \`process\` global (from vendored deps); without this they
     throw "process is not defined" and the dashboard never mounts from file. -->
<script>globalThis.process=globalThis.process||{env:{}};</script>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="hermetic" />
<title>${escapeHtmlText(title)}</title>
<style>${appCss}</style>
${profileCss ? `<style>${profileCss}</style>` : ""}
</head>
<body class="antialiased">
<div id="root"></div>
${jsonBlock("hermetic-spec", spec)}
${jsonBlock("hermetic-manifest", exportManifest)}
<script>${profileJs}</script>
</body>
</html>
`;

  return {
    html,
    report: {
      bundle,
      bytes: Buffer.byteLength(html, "utf-8"),
      elementCount: elements.length,
      fullOnlyTypesUsed,
    },
  };
}

function escapeHtmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * MCP App template assembler (SEP-1865): the SAME single-file viewer, minus
 * the data. Hosts that support MCP Apps (Claude Desktop et al.) fetch this
 * once via resources/read as `ui://hermetic/dashboard` and render it in a
 * sandboxed iframe; the spec then arrives per tool call through the
 * `ui/notifications/tool-result` structuredContent channel — so the template
 * is registered before any dashboard exists.
 *
 * Always the STANDARD profile: the template is re-sent to hosts that don't
 * cache, so the 11MB FULL bundle is off the table. Heavy chart families
 * (geo/3d/finance/polar) render the standard bundle's "unavailable" tile —
 * the tool result still carries dashboard_url for the complete view.
 *
 * The `mode: "mcp-app"` manifest flag (plus the absent #hermetic-spec block)
 * is what flips the shared export entry from read-inline-JSON to
 * wait-for-host-data.
 */
export async function exportAppTemplateHtml(input: {
  distDir: string;
}): Promise<{ html: string; bytes: number }> {
  const manifest = JSON.parse(
    await readFile(join(input.distDir, "export-manifest.json"), "utf-8")
  ) as ExportBuildManifest;
  const profile = manifest.profiles.standard;

  const [appCss, profileCss, profileJs] = await Promise.all([
    readFile(join(input.distDir, "export-app.css"), "utf-8"),
    readFile(join(input.distDir, profile.css), "utf-8").catch(() => ""),
    readFile(join(input.distDir, profile.js), "utf-8"),
  ]);

  const appManifest = {
    question: null,
    createdAt: null,
    generator: "hermetic",
    bundle: "standard",
    elementCount: 0,
    mode: "mcp-app",
  };

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<!-- Browser-safe process shim: the inlined bundle has a few unguarded reads
     of the Node \`process\` global (from vendored deps); without this they
     throw "process is not defined" and the dashboard never mounts from file. -->
<script>globalThis.process=globalThis.process||{env:{}};</script>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="hermetic" />
<title>hermetic dashboard</title>
<style>${appCss}</style>
${profileCss ? `<style>${profileCss}</style>` : ""}
</head>
<body class="antialiased">
<div id="root"></div>
${jsonBlock("hermetic-manifest", appManifest)}
<script>${profileJs}</script>
</body>
</html>
`;

  return { html, bytes: Buffer.byteLength(html, "utf-8") };
}

/** Filesystem-safe default filename for an export, from the question. */
export function exportFilename(question: string | null | undefined): string {
  const base = (question ?? "dashboard")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "dashboard"}.html`;
}

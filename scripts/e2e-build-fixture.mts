/**
 * Builds the e2e render fixture: exports a committed dashboard spec to a
 * self-contained HTML file that the Playwright test opens from file://. Kept
 * out of the Playwright runner (which doesn't resolve the app's @/ path
 * aliases) — run via tsx before `playwright test`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { exportDashboardHtml } from "@/lib/export/html-export";
import { viewerDistDir } from "@/mcp/viewer/dist-dir";

const OUT_DIR = join(process.cwd(), "e2e", ".artifacts");
mkdirSync(OUT_DIR, { recursive: true });

const spec = JSON.parse(readFileSync("test-specs/new-charts-smoke.json", "utf8"));
const { html } = await exportDashboardHtml({
  spec,
  question: "e2e smoke",
  createdAt: null,
  distDir: viewerDistDir(),
});
const out = join(OUT_DIR, "dashboard.html");
writeFileSync(out, html);
console.error(`e2e fixture written: ${out} (${html.length} bytes)`);

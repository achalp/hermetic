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

// ── D36 e2e fixture: a parquet with the exact shapes that broke live ──
// Quoted strings (Arrow toString → invalid JSON), BIGINT (JSON-unsafe), DECIMAL
// (unscaled-int normalization), DATE. Written via the in-process host DuckDB —
// no Docker. Consumed by e2e/wasm-range-extraction.spec.ts.
{
  const { hostExec } = await import("@/lib/sandbox/wasm/host-duckdb");
  const pq = join(OUT_DIR, "entities.parquet");
  await hostExec(
    `COPY (
       SELECT
         CAST(i AS BIGINT) AS big_id,
         lpad(CAST(i % 100 AS VARCHAR), 5, '0') AS fips_like,
         'label "' || i || '" with, punctuation' AS quoted_label,
         CAST(i AS DECIMAL(18,4)) / 7 AS ratio,
         DATE '2024-01-01' + CAST(i % 365 AS INTEGER) AS day
       FROM range(1000) t(i)
     ) TO '${pq.replace(/'/g, "''")}' (FORMAT PARQUET)`
  );
  console.error(`e2e fixture written: ${pq}`);
}

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportDashboardHtml, exportFilename, stripInternalState } from "../html-export";

let dist: string;

beforeAll(() => {
  // A miniature viewer build output — the assembler only reads files, so
  // the test controls every byte.
  dist = mkdtempSync(join(tmpdir(), "export-dist-"));
  writeFileSync(
    join(dist, "export-manifest.json"),
    JSON.stringify({
      fullOnlyTypes: ["Scatter3D", "Globe3D", "CandlestickChart"],
      profiles: {
        standard: { js: "export-standard.js", css: "export-standard.css", bytes: 10 },
        full: { js: "export-full.js", css: "export-full.css", bytes: 20 },
      },
    })
  );
  writeFileSync(join(dist, "export-app.css"), ":root{--x:1}");
  writeFileSync(join(dist, "export-standard.js"), "/*standard*/");
  writeFileSync(join(dist, "export-standard.css"), ".std{}");
  writeFileSync(join(dist, "export-full.js"), "/*full*/");
  writeFileSync(join(dist, "export-full.css"), ".full{}");
});

const barSpec = {
  root: "r",
  elements: {
    r: { type: "LayoutColumn", props: {}, children: ["c"] },
    c: { type: "BarChart", props: { title: "T" }, children: [] },
  },
  state: { datasets: { main: [{ a: 1 }] }, __cost: { usd: 1 }, __runId: "x" },
};

describe("exportDashboardHtml", () => {
  it("picks STANDARD for a nivo-only spec and inlines everything", async () => {
    const { html, report } = await exportDashboardHtml({
      spec: barSpec,
      question: "Revenue by region?",
      createdAt: "2026-08-05T00:00:00Z",
      distDir: dist,
    });
    expect(report.bundle).toBe("standard");
    expect(report.fullOnlyTypesUsed).toEqual([]);
    expect(html).toContain("/*standard*/");
    expect(html).not.toContain("/*full*/");
    expect(html).toContain('id="hermetic-spec"');
    expect(html).toContain('id="hermetic-manifest"');
    expect(html).toContain("Revenue by region?");
    // No external references — the single-file constraint.
    expect(html).not.toMatch(/src="[^d]/);
    expect(html).not.toContain('href="/assets');
  });

  it("picks FULL when a heavy type appears, and names the culprits", async () => {
    const spec = {
      ...barSpec,
      elements: {
        ...barSpec.elements,
        g: { type: "Globe3D", props: {}, children: [] },
      },
    };
    const { html, report } = await exportDashboardHtml({ spec, distDir: dist });
    expect(report.bundle).toBe("full");
    expect(report.fullOnlyTypesUsed).toEqual(["Globe3D"]);
    expect(html).toContain("/*full*/");
  });

  it("strips __-prefixed state but keeps datasets and control state", async () => {
    const stripped = stripInternalState(barSpec);
    expect(stripped.state).toEqual({ datasets: { main: [{ a: 1 }] } });
    const { html } = await exportDashboardHtml({ spec: barSpec, distDir: dist });
    expect(html).not.toContain("__cost");
    expect(html).not.toContain("__runId");
    expect(html).toContain("datasets");
  });

  it("escapes </script> inside embedded JSON so the file cannot self-truncate", async () => {
    const spec = {
      ...barSpec,
      elements: {
        r: { type: "TextBlock", props: { content: "x</script><script>alert(1)" }, children: [] },
      },
    };
    const { html } = await exportDashboardHtml({ spec, distDir: dist });
    expect(html).not.toContain("x</script><script>alert(1)");
    expect(html).toContain("x<\\/script>");
  });

  it("derives a safe filename from the question", () => {
    expect(exportFilename("Which repos gained stars in 2024?!")).toBe(
      "which-repos-gained-stars-in-2024.html"
    );
    expect(exportFilename(null)).toBe("dashboard.html");
  });
});

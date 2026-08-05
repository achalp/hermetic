/**
 * Browser entry for the SINGLE-FILE HTML export
 * (specs/dashboard-distribution-2026-08-05.md): the dashboard IS the file.
 *
 * Unlike the embedded viewer's entry (which fetches /api/spec/:id), this
 * entry reads everything from inline <script type="application/json"> blocks
 * the assembler (lib/export/html-export.ts) embedded:
 *   #hermetic-spec      — the dashboard spec (data included in its state)
 *   #hermetic-manifest  — question, as-of timestamp, generator, bundle name
 *
 * Same <SpecView>, same themes as the app — Tier-2 interactivity (filters,
 * cross-filter, drills) runs entirely client-side, so the file works from
 * file://, offline, forever. The footer is the adoption surface (spec §6):
 * the question that produced the dashboard, the as-of watermark, and a
 * quiet "made with hermetic" pointer — informative, never tracking.
 */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SpecView } from "@/components/spec-view";
import type { Spec } from "@/lib/contracts/spec";
import { STORAGE_KEYS } from "@/lib/constants";
import { THEME_IDS } from "@/components/theme/theme-config";
import { ThemeProvider } from "@/components/theme/theme-context";
import { ThemeControls } from "./chrome";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

export interface ExportManifest {
  question: string | null;
  createdAt: string | null;
  generator: string;
  bundle: "standard" | "full";
  /** Element count at export time — part of the exposure summary. */
  elementCount: number;
}

// No-FOUC bootstrap — same constants as the app/viewer so the allow-list
// can't drift. localStorage works from file:// (per-file origin in some
// browsers; degraded gracefully where blocked).
try {
  const d = document.documentElement;
  const t = localStorage.getItem(STORAGE_KEYS.theme);
  if (t && (THEME_IDS as string[]).includes(t)) d.setAttribute("data-theme", t);
  const m = localStorage.getItem(STORAGE_KEYS.mode);
  if (m === "dark") d.setAttribute("data-mode", "dark");
  else if (m === "light") d.setAttribute("data-mode", "light");
} catch {
  // storage unavailable — render with defaults
}

function readJson<T>(id: string): T | null {
  const el = document.getElementById(id);
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}

function AdoptionPanel({ manifest }: { manifest: ExportManifest }) {
  const [open, setOpen] = useState(false);
  return (
    <footer className="mx-auto mt-8 max-w-6xl border-t border-border-default px-6 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-t-tertiary">
        <span>
          {manifest.createdAt ? `As of ${new Date(manifest.createdAt).toLocaleString()} · ` : ""}
          self-contained file — {manifest.elementCount} elements, no server, no tracking
        </span>
        <span className="flex items-center gap-3">
          <button className="text-accent-text hover:underline" onClick={() => setOpen((o) => !o)}>
            Ask your own question
          </button>
          <a
            className="hover:underline"
            href="https://github.com/achalp/hermetic"
            target="_blank"
            rel="noreferrer"
          >
            Analyzed with hermetic — your data stays home
          </a>
        </span>
      </div>
      {open && (
        <div className="mt-3 rounded-card border border-border-default bg-surface-1 p-4 text-sm text-t-secondary">
          <p className="mb-2">
            This dashboard was produced by{" "}
            <a
              className="text-accent-text hover:underline"
              href="https://github.com/achalp/hermetic"
              target="_blank"
              rel="noreferrer"
            >
              hermetic
            </a>
            , an open-source, local-first AI data analyst: the model writes the analysis code, but
            it never sees your data.
          </p>
          <p className="mb-2">
            To ask your own questions of your own data:{" "}
            <code className="rounded-badge bg-surface-2 px-1 py-0.5 text-xs">
              git clone https://github.com/achalp/hermetic && cd hermetic && ./start.sh
            </code>
          </p>
          <p>
            Claude Desktop / Claude Code users:{" "}
            <code className="rounded-badge bg-surface-2 px-1 py-0.5 text-xs">
              ./scripts/install-mcp.sh
            </code>{" "}
            gives your agent these analysis tools directly.
          </p>
        </div>
      )}
    </footer>
  );
}

function ExportedDashboard() {
  const spec = readJson<Spec>("hermetic-spec");
  const manifest = readJson<ExportManifest>("hermetic-manifest") ?? {
    question: null,
    createdAt: null,
    generator: "hermetic",
    bundle: "standard" as const,
    elementCount: 0,
  };

  if (!spec) {
    return (
      <div className="p-8">
        <h1 className="mb-2 text-lg font-semibold text-t-primary">Could not load dashboard</h1>
        <p className="text-sm text-error-text">
          The embedded spec block is missing or corrupt — this file may have been truncated in
          transit. Re-export it from hermetic.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="mx-auto max-w-6xl p-6">
        <header className="mb-4 flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-semibold text-t-primary">
            {manifest.question ?? "Analysis"}
          </h1>
          <span className="flex shrink-0 items-center gap-3">
            <ThemeControls />
            <span className="text-xs text-t-tertiary">hermetic</span>
          </span>
        </header>
        <SpecView spec={spec} />
      </div>
      <AdoptionPanel manifest={manifest} />
    </>
  );
}

const rootEl = document.getElementById("root");
if (rootEl)
  createRoot(rootEl).render(
    <ThemeProvider>
      <ExportedDashboard />
    </ThemeProvider>
  );

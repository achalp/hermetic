/**
 * The embedded viewer's browser entry (mcp-server spec §4 M3).
 *
 * A minimal harness around <SpecView> — the SAME renderer the web app
 * mounts — served by the MCP process itself so dashboard links never depend
 * on `pnpm dev` running. Reads ?restore=<id>, fetches the persisted spec
 * from the viewer server's /api/spec/:id, renders it fully interactive.
 *
 * Visual parity with the web app is part of the contract: the same Geist
 * fonts (self-hosted here — next/font is unavailable outside Next), the same
 * ThemeProvider + data-theme/data-mode attributes, and the same theme choices
 * offered in the header. Theme preference persists per the shared storage
 * keys, though the viewer origin's localStorage is its own.
 *
 * This file is a BROWSER bundle entry (built by scripts/build-mcp-viewer.mjs
 * via esbuild); it is never imported by the MCP server's node graph — the
 * server serves the BUILT artifact from disk. That split is what keeps the
 * harness free of React while the viewer keeps the real renderer.
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { SpecView } from "@/components/spec-view";
import type { Spec } from "@/lib/contracts/spec";
import { STORAGE_KEYS } from "@/lib/constants";
import { THEME_IDS } from "@/lib/theme-config";
import { ThemeProvider, useTheme, THEMES, type ColorMode } from "@/lib/theme-context";
// Geist via @fontsource-variable: esbuild bundles these into the entry css
// with the woff2 files as hashed assets. app.css maps --font-geist-sans/mono
// to these family names (scripts/build-mcp-viewer.mjs).
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
// NOTE: no globals.css import here — esbuild cannot run the Tailwind engine.
// The stylesheet is built separately (scripts/build-mcp-viewer.mjs step 1)
// and linked by viewer.html as /assets/app.css.

// No-FOUC bootstrap: same behavior as the web app's inline <head> script
// (src/app/layout.tsx), sharing its constants so the allow-list cannot drift.
// Module scope runs before React renders anything.
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

interface LoadedEntry {
  spec: Spec;
  question: string | null;
}

const MODES: { id: ColorMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

/** The web app's theme + mode choices, compacted for the viewer header. */
function ThemeControls() {
  const { theme, setTheme, mode, setMode } = useTheme();
  const selectClass =
    "rounded-badge border border-border-default bg-surface-1 px-1.5 py-0.5 text-xs " +
    "text-t-secondary focus:outline-none focus:ring-1 focus:ring-accent";
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <select
        aria-label="Theme"
        className={selectClass}
        value={theme}
        onChange={(e) => setTheme(e.target.value as (typeof THEMES)[number]["id"])}
      >
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Color mode"
        className={selectClass}
        value={mode}
        onChange={(e) => setMode(e.target.value as ColorMode)}
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function Viewer() {
  const [state, setState] = useState<
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "ready"; entry: LoadedEntry }
  >({ phase: "loading" });

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("restore");
    if (!id) {
      setState({ phase: "error", message: "Missing ?restore=<history-id> in the URL." });
      return;
    }
    fetch(`/api/spec/${encodeURIComponent(id)}`)
      .then(async (res) => {
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        return res.json();
      })
      .then((entry: LoadedEntry) => setState({ phase: "ready", entry }))
      .catch((err) =>
        setState({ phase: "error", message: err instanceof Error ? err.message : String(err) })
      );
  }, []);

  if (state.phase === "loading") {
    return <div className="p-8 text-sm text-t-secondary">Loading analysis…</div>;
  }
  if (state.phase === "error") {
    return (
      <div className="p-8">
        <h1 className="mb-2 text-lg font-semibold text-t-primary">Could not load analysis</h1>
        <p className="text-sm text-error-text">{state.message}</p>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-t-primary">
          {state.entry.question ?? "Analysis"}
        </h1>
        <span className="flex shrink-0 items-center gap-3">
          <ThemeControls />
          <span className="text-xs text-t-tertiary">hermetic · MCP viewer</span>
        </span>
      </header>
      <SpecView spec={state.entry.spec} />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl)
  createRoot(rootEl).render(
    <ThemeProvider>
      <Viewer />
    </ThemeProvider>
  );

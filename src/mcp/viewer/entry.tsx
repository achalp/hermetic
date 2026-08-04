/**
 * The embedded viewer's browser entry (mcp-server spec §4 M3).
 *
 * A minimal harness around <SpecView> — the SAME renderer the web app
 * mounts — served by the MCP process itself so dashboard links never depend
 * on `pnpm dev` running. Reads ?restore=<id>, fetches the persisted spec
 * from the viewer server's /api/spec/:id, renders it fully interactive.
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
// NOTE: no globals.css import here — esbuild cannot run the Tailwind engine.
// The stylesheet is built separately (scripts/build-mcp-viewer.mjs step 1)
// and linked by viewer.html as /assets/viewer.css.

interface LoadedEntry {
  spec: Spec;
  question: string | null;
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
        <span className="shrink-0 text-xs text-t-tertiary">hermetic · MCP viewer</span>
      </header>
      <SpecView spec={state.entry.spec} />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<Viewer />);

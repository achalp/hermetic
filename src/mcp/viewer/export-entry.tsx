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
 *
 * SECOND MODE — MCP App (SEP-1865): when the manifest says `mode:"mcp-app"`
 * there is no spec block at all. The same bundle is then the `ui://` template
 * a host renders in a sandboxed iframe: it handshakes over postMessage
 * (ext-apps App), receives the spec via `ui/notifications/tool-result`
 * structuredContent, and follows the host's theme. One bundle, two bootstraps
 * — the assemblers differ only in which JSON blocks they embed.
 */
import React, { useEffect, useState } from "react";
import { errMessage } from "@/lib/logger";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
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
  /** Absent for single-file exports; "mcp-app" flips to the host-data bootstrap. */
  mode?: "mcp-app";
}

/**
 * What the server puts in the tool result's structuredContent for the app
 * iframe (mcp/tools attach it as the UI payload; the wiring lifts it out).
 * The host never shows this to the model — it is the UI data channel.
 */
interface AppUiPayload {
  spec?: Spec;
  question?: string | null;
  created_at?: string | null;
  dashboard_url?: string | null;
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

/**
 * Host theme → hermetic's mode attribute. The ThemeProvider reads data-mode
 * from the document element (same contract as the no-FOUC bootstrap), so
 * following the host is one attribute write.
 */
function applyHostTheme(theme: unknown): void {
  if (theme === "dark" || theme === "light")
    document.documentElement.setAttribute("data-mode", theme);
}

/**
 * The in-flight state: the host mounts the iframe the moment the tool call
 * STARTS, and an analyze run takes seconds to minutes. The extension gives
 * the iframe no channel for the pipeline's real progress notifications
 * (those flow host-side only), so this shows only what is true: the question
 * (from ui/notifications/tool-input), what hermetic does during a run, an
 * indeterminate sweep, and honest elapsed time — never a fabricated stage
 * or percentage.
 */
function AnalysisPending({ question }: { question: string | null }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-3 p-8">
      <style>{`
        @keyframes hermetic-sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(350%); }
        }
      `}</style>
      <p className="text-sm font-medium text-t-primary">
        {question ? "Running analysis" : "Waiting for the analysis"}
      </p>
      {question ? (
        <p className="max-w-md text-center text-sm text-t-secondary">“{question}”</p>
      ) : null}
      <div className="h-1 w-56 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full w-1/3 rounded-full bg-accent-text opacity-70"
          style={{ animation: "hermetic-sweep 1.4s ease-in-out infinite" }}
        />
      </div>
      <p className="text-xs text-t-tertiary">
        hermetic is generating analysis code, executing it in the local sandbox, and composing the
        dashboard — {elapsed}s elapsed
      </p>
    </div>
  );
}

function McpAppDashboard() {
  const [app, setApp] = useState<App | null>(null);
  const [payload, setPayload] = useState<AppUiPayload | null>(null);
  const [question, setQuestion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  useEffect(() => {
    const bridge = new App({ name: "hermetic-dashboard", version: "1.0.0" }, {});
    // Handlers attach BEFORE connect so a fast host can't slip a
    // notification past the mount.
    bridge.ontoolinput = (params) => {
      // analyze carries `question`; persist_dashboard carries `title`.
      const args = params.arguments as { question?: string; title?: string } | undefined;
      setQuestion(args?.question ?? args?.title ?? null);
    };
    const noPayloadError = (sc: unknown) => {
      const keys = sc
        ? `structuredContent keys: ${Object.keys(sc as object).join(", ")}`
        : "no structuredContent in the tool result";
      setError(
        `The analysis finished, but the host did not deliver the dashboard data to this ` +
          `panel (${keys}).`
      );
    };
    const payloadFrom = (res: {
      structuredContent?: unknown;
      content?: unknown;
    }): AppUiPayload | null => {
      const sc = res.structuredContent as AppUiPayload | undefined;
      if (sc?.spec) return sc;
      try {
        const text = (res.content as Array<{ text?: string }>)?.[0]?.text;
        const parsed = text ? (JSON.parse(text) as AppUiPayload) : null;
        return parsed?.spec ? parsed : null;
      } catch {
        return null;
      }
    };
    bridge.ontoolresult = (params) => {
      const ui = params.structuredContent as AppUiPayload | undefined;
      if (ui?.spec) {
        setPayload(ui);
        return;
      }
      // The notification arrived without the payload (Claude Desktop strips
      // structuredContent in forwarding, today). Salvage what the JSON text
      // block carries — the dashboard link as a last resort, and history_id
      // as the key to PULL the payload ourselves: a direct tools/call from
      // this iframe returns over the app bridge, with no lossy hop.
      let parsed: Record<string, unknown> | null = null;
      try {
        const text = (params.content as Array<{ text?: string }>)?.[0]?.text;
        parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      if (typeof parsed?.dashboard_url === "string") setFallbackUrl(parsed.dashboard_url);
      const historyId = typeof parsed?.history_id === "string" ? parsed.history_id : null;
      if (!historyId) {
        noPayloadError(params.structuredContent);
        return;
      }
      void bridge
        .callServerTool(
          { name: "dashboard_data", arguments: { history_id: historyId } },
          { timeout: 30_000 }
        )
        .then((res) => {
          const fetched = payloadFrom(res);
          if (fetched) setPayload(fetched);
          else noPayloadError(params.structuredContent);
        })
        .catch(() => noPayloadError(params.structuredContent));
    };
    bridge.ontoolcancelled = () => setError("The analysis was cancelled before it finished.");
    bridge.onhostcontextchanged = (ctx) => applyHostTheme(ctx.theme);
    bridge
      .connect()
      .then(() => {
        applyHostTheme(bridge.getHostContext()?.theme);
        setApp(bridge);
      })
      .catch((e: unknown) => setError(errMessage(e)));
    return () => void bridge.close().catch(() => {});
  }, []);

  if (error) {
    return (
      <div className="p-8">
        <h1 className="mb-2 text-lg font-semibold text-t-primary">No dashboard to show</h1>
        <p className="text-sm text-error-text">{error}</p>
        {fallbackUrl ? (
          <button
            className="mt-3 text-sm text-accent-text hover:underline"
            onClick={() => void app?.openLink({ url: fallbackUrl }).catch(() => {})}
          >
            Open the dashboard in your browser instead
          </button>
        ) : null}
      </div>
    );
  }
  if (!payload?.spec) {
    return <AnalysisPending question={question} />;
  }

  return (
    <div className="p-4">
      <header className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold text-t-primary">{payload.question ?? "Analysis"}</h1>
        <span className="flex shrink-0 items-center gap-3">
          {payload.dashboard_url ? (
            <button
              className="text-xs text-accent-text hover:underline"
              onClick={() => void app?.openLink({ url: payload.dashboard_url! }).catch(() => {})}
            >
              Open full dashboard
            </button>
          ) : null}
          <span className="text-xs text-t-tertiary">hermetic</span>
        </span>
      </header>
      <SpecView spec={payload.spec} />
      {payload.created_at ? (
        <p className="mt-4 text-xs text-t-tertiary">
          As of {new Date(payload.created_at).toLocaleString()} · analyzed with hermetic — your data
          stays home
        </p>
      ) : null}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  const isApp = readJson<ExportManifest>("hermetic-manifest")?.mode === "mcp-app";
  createRoot(rootEl).render(
    <ThemeProvider>{isApp ? <McpAppDashboard /> : <ExportedDashboard />}</ThemeProvider>
  );
}

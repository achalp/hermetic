# Published Artifacts / Sharing — WIP Spec

> Created: 2026-06-17
> Status: WIP — DISCUSSION ONLY. No implementation yet. Captures the design exploration and the decisions/constraints reached; artifacts (bundle schema, deep-link flow) deferred to a follow-up.
> Related: DuckDB + Parquet + local-file support (`project_duckdb_parquet`), Notebook Mode (`specs/notebook-mode-2026-06-11.md`), output-styles / slides export (`src/lib/slides-export.ts`).

## 1. Goal & constraints

Let someone **publish a result or investigation as a "web app" anyone can use** — without standing up hosting, without sharing data-source credentials, and without the recipient needing the full toolchain just to look.

Hard constraints (from the product and from this discussion):

- **Not a hosted solution.** We never hold the user's data or run their queries on our infrastructure.
- **No shared auth to data sources.** A recipient must not need (or receive) the publisher's warehouse credentials.
- **Audience: internal team.** Colleagues who may already have Hermetic installed; sharing is handoff + collaboration, not anonymous public distribution.
- **Interactivity target: Tier 2 (filter / explore).** Recipient can change filters, parameters, cross-filter — but **not** ask new questions in the artifact itself. Client-side only.
- **Data profile: large / warehouse-sourced.** Requires a Parquet snapshot + DuckDB-WASM, materialized at publish time (cannot inline raw rows as JSON).

## 2. The key enabler we already have

Hermetic's rendered output is **already a self-contained, client-side artifact**: a result is a JSON-render spec; the `DataController` injects the dataset into `/state/datasets/main` and does **filtering/aggregation in the browser**; charts read from client state. So a published analysis needs a _browser_, not _our server_. Most BI tools can't say this because their interactivity round-trips to a query engine. This single fact is what makes "no hosting, no shared auth" tractable.

## 3. Interactivity tiers (the central tension: interactivity vs. no-backend)

| Tier              | What survives                                                   | Cost                             | Needs a backend?   |
| ----------------- | --------------------------------------------------------------- | -------------------------------- | ------------------ |
| **1 Frozen**      | View the composed dashboard/investigation; pre-computed numbers | Tiny                             | No                 |
| **2 Interactive** | Filters, cross-filter, parameter sliders, re-aggregation        | Ship data (Parquet) + chart libs | No                 |
| **3 Live**        | Re-ask questions, re-run Python, new investigations             | The whole LLM + sandbox engine   | **Yes** — boundary |

Chosen target is **Tier 2**, which is nearly free because the DataController already runs client-side.

## 4. SOTA landscape (no-hosting sharing)

The mature lineage is **"static bundle + WASM"** — move the "build" to publish time, freeze a data snapshot, let WASM do the rest in the recipient's browser:

- **Observable Framework / Evidence.dev / Rill** — BI/data-app-as-code compiled to a static site; data loaders run at **build time**, ship pre-baked results (often Parquet) queried client-side with **DuckDB-WASM**. Closest analog to what we should emit.
- **datasette-lite / DuckDB-WASM / stlite / FINOS Perspective** — SQLite/DuckDB/Streamlit/pivot engines running fully in-browser. Proof that real querying with zero server is production-grade.
- **JupyterLite / Quarto** — notebooks as static files (Pyodide). Relevant to publishing **investigations** as interactive computational narratives.
- **Single-file HTML** (Plotly/Bokeh standalone, Observable embeds) — everything inlined into one `.html`. Good for small/frozen; not viable for large data.

## 5. Chosen architecture: a snapshot bundle rendered over DuckDB-WASM

A published artifact = **`spec.json` + `data.parquet` + `manifest.json`**, rendered client-side. Not a frozen blob and not the live warehouse — a **right-grained Parquet snapshot** the recipient's browser queries with DuckDB-WASM (the Evidence/Rill model). Reuses our existing DuckDB + Parquet infra rather than inventing it.

### 5.1 The crux — materialize at the _grain the interactions need_

The whole game for "large + Tier 2": don't ship the raw fact table (too big, max PII exposure) and don't ship the final aggregate (kills interactivity). Instead **static-analyze the spec's DataController** — its filterable columns, group keys, measures — and materialize _exactly that projection at exactly that grain_.

> interactions = "filter by region, group by month, measure = revenue" → materialize `(region, month, sum(revenue))`.

Often a few MB even from a billion-row warehouse, contains **no raw rows**, supports every client-side interaction the dashboard offers. Derive it by walking the spec (reuse the `walkElement` pattern in `spec-summary.ts`). Rule: materialize at the **finest grain any interaction needs**; if a drill-to-detail exists, either include that grain (bigger, more sensitive) or disable that drill in published mode and say so in the manifest.

### 5.2 The bundle is also a credential-free "reconnection recipe"

The bundle carries warehouse **identity**, the query/SQL lineage, params, and the original question — but **never creds or raw data beyond the snapshot**. Going live (Tier 3) is "the full app re-establishing the real connection using _the viewer's own_ credentials," not "extending the snapshot." This dissolves the shared-auth problem: auth is re-acquired per viewer, in their own install, never shipped.

## 6. Distribution: two open paths (leaning into "internal team")

Because colleagues may already run Hermetic:

1. **Open in the recipient's Hermetic** — read-only "published view" mode. Bundle carries only `spec + parquet + manifest`; their install provides the renderer, DuckDB-WASM, and chart bundles. Tiny bundles. The common internal case.
2. **Static viewer** — one static HTML page (internal static host) that loads the bundle + DuckDB-WASM + JSON-render runtime + _only the chart bundles the spec actually uses_ (charts are already dynamic-imported, so the viewer pulls Plotly only when a Plotly chart is present). For colleagues without an install.

Both render identically — same renderer, same spec.

## 7. The Tier-2 → Tier-3 upgrade (graceful, consent-based)

Product instinct (from discussion): don't dead-end a viewer who wants to ask a new question — offer a graceful upgrade from frozen artifact to live tool. This is the proven "open in desktop app" pattern (Figma `figma://`, VS Code "Open in Desktop", Zoom, Slack).

**Hard constraint:** a web page **cannot** silently download-install-run a native app (browser sandbox forbids it; security teams block it). So the literal "auto-install and open live" idea is dropped. Replace with **consent-based handoff:**

- **Hermetic installed (common internal case):** the artifact's "ask a new question" action fires a `hermetic://open?bundle=…` deep link → installed app opens, reads the reconnection recipe, prompts for warehouse creds, reconnects, rehydrates the analysis, accepts new questions. This is the seamless moment.
- **Not installed (cold start):** reveal a one-screen "Go further with Hermetic" → download link + "this analysis reopens once installed" (via file association / deep link). Two user-driven clicks, no silent install.

**Prerequisite:** a **packaged desktop Hermetic** (Tauri/Electron wrapping the Next app + sandbox + DuckDB) that registers the `hermetic://` protocol and `.hermetic` file association. If Hermetic stays "git clone + `npm run dev`", the handoff is clunky for non-developers. Worth doing for the live product regardless.

## 8. Governance (a published bundle is a data export — treat it like one)

- Publish-time confirmation: _"this bundle contains N rows × [these columns] as of [time]."_
- Column policy: denylist / "aggregate-only this column" so sensitive fields never enter the Parquet.
- Hard secret-stripping (no connection strings / API keys / `__warehouse_csv_id`-style internals) — fold into the publish finalizer.
- Optional as-of watermark / expiry so a stale snapshot isn't mistaken for live.

## 9. Locked decisions

1. Target **Tier 2** interactivity, **internal** audience, **large/warehouse** data.
2. Artifact = **`spec.json` + `data.parquet` + `manifest.json`**, rendered client-side over **DuckDB-WASM**.
3. **Materialize at publish time at the grain the spec's interactions need** (projection derived by static spec analysis), not raw rows and not final aggregates.
4. Bundle doubles as a **credential-free reconnection recipe**; creds and raw data are never shipped.
5. **Two open paths:** recipient's installed Hermetic (primary) and a static viewer (fallback).
6. Tier-2→Tier-3 upgrade is a **consent-based `hermetic://` deep-link handoff + download fallback** — NOT silent auto-install.
7. Publishing is governed like a data export (exposure summary, column policy, secret-stripping).

## 10. Build order (when greenlit)

1. **Parquet-backed DataController** — source mode where filter/group/compute compile to **DuckDB-WASM SQL over a Parquet** instead of scanning a JS array. The one substantial new capability; also upgrades the live product for large local Parquet files. _Highest leverage._
2. **Spec → required-projection analysis** — derive filter columns + group keys + measures + grain; drives materialization and warns on out-of-grain drills.
3. **Publish command** — run the projection query once, write `data.parquet`, emit the `.hermetic` bundle, strip secrets, show the data-exposure summary.
4. **Read-only "published view"** in Hermetic + the **static viewer** page.
5. **`hermetic://` deep-link + desktop packaging** + "refresh with my creds" (Tier-3 escape hatch).

The interactive bundle (1–4) is independently valuable; most viewers never need to go live. The deep-link upgrade (5) is an additive layer once desktop packaging exists.

## 11. Open questions / deferred

- `.hermetic` bundle + `manifest.json` schema (reconnection-recipe fields; explicit exclusions). _Deferred to follow-up._
- Exact `hermetic://` open flow + protocol/file-association registration. _Deferred._
- Desktop packaging choice (Tauri vs Electron) and its effect on sandbox/DuckDB bundling.
- Drill-below-grain policy: include finer grain vs. disable drill in published mode (per-spec or global default?).
- Investigations: a published investigation is the notebook view as a static computational narrative (each cell's spec + frozen data + citations as anchors) — same export machinery, multi-cell. Confirm the per-cell snapshot grain story.

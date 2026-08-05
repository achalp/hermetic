# Dashboard distribution — the dashboard IS the file

> Created: 2026-08-05
> Status: v1 IMPLEMENTED (2026-08-05) — build order items 1–4 shipped: export
> profiles in the viewer build, `lib/export/html-export.ts` assembler, all
> three harness surfaces (web export menu + POST /api/export-html +
> GET /api/export/[id]; `hermetic render --html`; MCP `export_dashboard` +
> `export_url` on analyze + viewer Download button), governance floor
> (`__`-state strip, as-of watermark, exposure line). v2 (DuckDB-WASM
> Parquet snapshots) remains open. Supersedes the distribution section (§6) of
> `specs/published-artifacts-sharing-2026-06-17.md`; inherits its locked
> decisions on interactivity tiers, grain materialization, governance, and
> the Tier-3 handoff. Those analyses still stand; what changed is HOW the
> artifact travels.
> Related: `specs/competitive-feature-gaps-2026-04-25.md` item 8 (static
> shareable export — identified as the "I can't show this to a colleague"
> gap); MCP viewer (`src/mcp/viewer/`, spec §4 M3).

## 1. Requirements (2026-08-05)

1. **Simple to share** — one gesture. No bundle-plus-viewer pairs, no
   "first install…", no instructions in the email body.
2. **Omnipresent** — opens wherever the recipient already is: laptop,
   phone, locked-down corporate machine, no install rights, offline.
3. **Infra-free** — nothing hosted, by us or by the user. No static host,
   no link that can rot, no server that can be down.
4. **Interactive** — Tier 2 (filter, cross-filter, drill, parameters), not
   a screenshot.
5. **Encourages adoption** — every shared dashboard should sell the tool
   that made it, without being obnoxious about it.

## 2. What the June spec got right, and where it now fails the bar

The June discussion locked the right foundation: interactivity is Tier 2;
the artifact is spec + data + manifest rendered fully client-side; data is
materialized at the grain the interactions need; publishing is governed
like a data export; going live again is a credential-free reconnection
recipe, never shipped creds. All inherited unchanged.

Its two distribution paths fail the new requirements:

- "Open in the recipient's Hermetic" fails **omnipresent** (requires an
  install) and **simple** (requires knowing the recipient has one).
- "Static viewer on an internal static host" fails **infra-free** — an
  internal host is exactly the infrastructure the product promises nobody
  has to stand up.

## 3. What changed since June: the static viewer got built by accident

The MCP embedded viewer (M3) is, structurally, the June spec's "static
viewer" already shipped: `scripts/build-mcp-viewer.mjs` compiles the REAL
renderer closure — `<SpecView>`, the theme system, Geist, code-split chart
chunks — into a framework-free browser bundle, proven outside Next on every
CI run (the isolation check guards the closure's 131 files continuously).
The only thing tying it to a server is that `entry.tsx` FETCHES the spec
from `/api/spec/:id`. Inline the spec and data instead, and the server
disappears.

Second change: the hardening waves made the renderer's inputs honest typed
contracts (`AssembledSpec`, owned `PatchLine`, spec-summary walkers), so
"walk the spec, decide what to inline" is now a typed operation, not a
cast-fest.

## 4. Proposal: single-file HTML export

**A dashboard exports to ONE self-contained `.html` file.** Spec, data,
renderer, charts, themes, fonts — inlined. Drop it in Slack, attach it to
email, put it on a shared drive, AirDrop it. Double-click opens it in any
browser, forever, offline.

| Requirement | How the file meets it                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Simple      | One file, one gesture. The share medium is whatever the team already uses.                                                              |
| Omnipresent | Every device with a browser. No install, no account, no network.                                                                        |
| Infra-free  | Literally zero: no host, no link rot, no uptime. Also the strongest possible privacy statement — the file visibly IS the entire export. |
| Interactive | The DataController already runs client-side (June §2); the exported file keeps filters, cross-filter, drills, parameters.               |
| Adoption    | §6 — the file is a self-demonstrating artifact.                                                                                         |

### 4.1 Composition (all existing machinery, one new assembler)

- **Renderer packs, built once** (extend `build-mcp-viewer.mjs`): the
  esbuild output already code-splits by chart family (nivo core, plotly
  cartesian/3d/finance/polar, deck.gl/maplibre, globe). Publish each pack
  as an inlinable asset alongside the existing viewer build.
- **Per-export assembly** (the new piece, small): walk the spec's component
  types (the `extractProse`/catalog walkers pattern), map type → required
  packs via the registry's lazy-import table, and emit one HTML file:
  core pack + only the packs used + theme CSS + fonts + `<script
type="application/json">` blocks for spec, datasets, artifacts, and
  manifest. A stat-cards-and-bar-charts dashboard ships nivo only —
  low single-digit MB; a globe dashboard pays for a globe.
- **Data at interaction grain**: v1 inlines exactly what the live
  dashboard already holds client-side (`/state/datasets` + chart_data +
  results) — for CSV-scale flows that IS the interaction grain, no new
  analysis needed. The June §5.1 projection-materialization and
  DuckDB-WASM-over-embedded-Parquet remain the v2 path for
  large/warehouse snapshots (base64 Parquet in the same single file; the
  Parquet-backed DataController stays the build-order item it was).
- **Entry**: a sibling of `src/mcp/viewer/entry.tsx` that reads the inline
  JSON instead of fetching. Same `<SpecView>`, same themes; theme picker
  included (localStorage works from `file://`).

### 4.2 Surfaces (omnipresent on the PRODUCING side too)

Same feature, every harness:

- Web app: "Download as interactive HTML" in the existing export menu
  (beside PDF/PPTX — this is competitive-gaps item 8, two years listed).
- CLI: `hermetic render <history-id> --html out.html` (docs/cli.md already
  promises a render command).
- MCP: an `export_dashboard` tool — the agent hands the user a file, which
  is precisely the durable-artifact thesis of the MCP spec, now portable
  beyond the machine.

### 4.3 Governance (inherited from June §8, unchanged)

Export-time exposure summary ("this file contains N rows × these columns,
as of T"), column deny/aggregate-only policy, hard secret-stripping (the
manifest's reconnection recipe carries warehouse identity + question + SQL
lineage, never creds), visible as-of watermark in the exported footer.

## 5. Size honesty

The full MCP viewer bundle (every chart family) is ~13 MB. Per-spec pack
selection is what makes the single file respectable: nivo-only dashboards
should land ~1–3 MB; plotly adds ~3–4 MB; geo/globe the most. Two rules:
(a) the exporter PRINTS the breakdown (packs + data) so size is never a
surprise; (b) if a spec pulls >2 heavy families, suggest — don't force —
splitting or accepting the weight. Email's ~25 MB ceiling is the practical
bound; Slack/drives don't care.

## 6. Adoption: the file is the demo

Every exported dashboard carries, in a footer that is informative rather
than promotional:

- **The question that produced it** — verbatim, with the as-of date. This
  is the hook: the recipient's next thought is "can I ask it something?"
- **"Analyzed with hermetic — your data stays home"** linking to the repo.
  One line, one link, no tracking (infra-free includes analytics-free).
- **"Ask your own question"** — opens a small static panel: what hermetic
  is, the one-command install (`./start.sh`, `install-mcp.sh` for Claude),
  and — when the manifest carries a reconnection recipe — "this analysis
  can be reopened live against your own credentials." The June `hermetic://`
  deep-link/desktop-packaging idea remains the eventual seamless version
  of this panel (§7 there), not a v1 dependency.

The loop: analyst shares a file because it's the easiest way to share a
dashboard (not as a favor to us) → recipient interacts, sees the question

- footer → recipient becomes an analyst. Distribution and growth are the
  same artifact.

## 7. Build order

1. **Pack build** — extend `build-mcp-viewer.mjs` to emit per-family packs
   - a core pack (renderer, themes, fonts) as inlinable assets. (Small;
     the code-splitting already exists.)
2. **Assembler** — `lib/export/html-export.ts`: spec walk → pack set →
   single-file emit with inline JSON + manifest + footer. Framework-free
   lib, callable from all three harnesses.
3. **Surfaces** — export-menu entry, `hermetic render --html`, MCP
   `export_dashboard`.
4. **Governance pass** — exposure summary + secret-strip finalizer (share
   with the June follow-up).
5. **v2** — base64-Parquet + DuckDB-WASM pack for large/warehouse
   snapshots, riding the Parquet-backed DataController (June build-order
   item 1) when that lands.

Items 1–3 are a shippable v1: CSV-scale dashboards (the overwhelmingly
common case) become one-file shareable with full interactivity.

## 8. Open questions

- Fonts: subset Geist into the file (~100–300 KB) vs system-font fallback
  for exports (smaller; slight fidelity loss). Lean: subset, it's cheap.
- Notebook/investigation export: same assembler, multi-cell — confirm the
  per-cell data story (June §11 carries this question; unchanged).
- CSP/file:// quirks: verify plotly/deck WASM-free operation from file://
  (nivo is pure SVG/DOM — safe); document any family that degrades.
- Should `analyze` (MCP) return the HTML alongside the dashboard link when
  the host asks? Lean: separate tool; keep analyze's response light.

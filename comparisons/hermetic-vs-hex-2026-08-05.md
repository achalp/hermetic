# Hermetic vs Hex.tech — Competitive Feature Comparison

_Last updated: 2026-08-05_

_Previous versions of this comparison: [2026-06-20](./hermetic-vs-hex-2026-06-20.md), [2026-05-31](./hermetic-vs-hex-2026-05-31.md), [2026-04-25](./hermetic-vs-hex-2026-04-25.md), [2026-03-24](./hermetic-vs-hex.md). This update covers two Hermetic release waves plus a same-day feature. **July** ([release notes](../release-notes/hermetic-blog-post-july.md)): cloud Parquet querying on S3/GCS/HTTPS at billion-row scale with no warehouse, a **skills** system (teachable business definitions + your own tested Python modules, enforced), a pre-execution code review gate, removal of the analysis time limit (progress visibility, stop button, sleep/reload-surviving reconnect), a claude-cli subscription transport (no API key), follow-up context inheritance for warehouse queries, and schema caching. **August** ([release notes](../release-notes/hermetic-blog-post-august.md), [docs/mcp.md](../docs/mcp.md)): Hermetic is now an **MCP server** — nine tools with `analyze` as the flagship, so any MCP host (Claude Desktop, Claude Code, Cursor) becomes a Hermetic front end, with an embedded dashboard viewer, a documented trust model, an error taxonomy with contract versioning, and a one-command installer. **Today** ([spec](../specs/dashboard-distribution-2026-08-05.md), implemented): **single-file interactive HTML export** — one self-contained .html per dashboard, offline forever, from every surface. Unlike the last edition, the Hex side is re-verified from primary sources: their [changelog](https://learn.hex.tech/changelog) shows a busy June–August (Hex Agent via CLI and API Jul 30, agent Evals Aug 4, generative-app improvements Jul 21, credit controls Jul 14, a multi-model picker Jul 8), and this survey also picks up Hex's own **MCP story** (remote MCP server since [Oct 29, 2025](https://hex.tech/blog/introducing-agent-in-slack-and-mcp/), Hex-as-MCP-client since [May 28, 2026](https://learn.hex.tech/changelog/2026-05-28)) which earlier editions never covered. Published seat pricing is unchanged ($36/$75, [hex.tech/pricing](https://hex.tech/pricing/) checked 2026-08-05)._

## Overview

| Category        | Hermetic                                                                                                           | Hex.tech                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Core Model**  | AI-first: ask a question, get a complete dashboard. Investigate decomposes into sub-steps. Now also an MCP toolbox | AI Analytics Platform: notebooks + Hex Agent (browser, Slack, CLI, API, MCP) + apps   |
| **Deployment**  | Self-hosted / local-first                                                                                          | Cloud SaaS only (single-tenant Enterprise option)                                     |
| **Pricing**     | Open source (free)                                                                                                 | Free → $36/editor/mo (Pro) → $75/editor/mo (Team) → custom; per-seat AI credit grants |
| **Target User** | Analyst who wants answers fast, no code, data stays local — and now any agent that speaks MCP                      | Cross-functional data team: analysts, engineers, business users                       |
| **AI Posture**  | LLM never sees the data — schema-only context, blind sandboxed execution, pre-execution review                     | Hex Agent has full schema + project context, generates and runs code in Hex's cloud   |

---

## Data Sources

| Feature                                             | Hermetic                                                                                                                                                        | Hex                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CSV / Excel / GeoJSON / JSON                        | Yes (multi-sheet Excel with cross-sheet FK detection, GeoJSON auto-geometry)                                                                                    | Yes (basic upload; GeoJSON via Python)                                                |
| Parquet files (single + Hive-partitioned)           | Yes (DuckDB-backed, zero-copy bind-mount)                                                                                                                       | Yes                                                                                   |
| **Cloud Parquet on S3 / GCS / HTTPS**               | **Yes (new — analyzed in place, nothing downloaded, no warehouse; proven on Overture Maps' ~2.5B-row catalog via metadata pruning → coarse-to-fine narrowing)** | S3 as a data connection (now with AWS IAM roles)                                      |
| Local file browser                                  | Yes (browse host filesystem from sandbox)                                                                                                                       | No                                                                                    |
| PostgreSQL / Redshift / Neon / Supabase             | Yes (PG-wire compatible)                                                                                                                                        | Yes                                                                                   |
| BigQuery / Snowflake / Databricks                   | Yes (dialect-aware SQL, saved + inline connections)                                                                                                             | Yes (native + pushdown; Snowflake schema refresh up to 10x faster since Jul 30, 2026) |
| ClickHouse / Trino / Starburst / Hive               | Yes                                                                                                                                                             | Yes (Hive via Trino)                                                                  |
| MySQL / SQL Server / Oracle / Athena                | No (AlloyDB via PG-wire)                                                                                                                                        | Yes (Athena/Redshift/RDS/S3 gained AWS IAM role auth Jun 25, 2026)                    |
| **Schema caching**                                  | **Yes (new — schemas remembered + verified on reconnect, not rebuilt)**                                                                                         | Yes (incremental refresh + admin refresh history, Jun–Jul 2026)                       |
| dbt metadata enrichment                             | Yes (column descriptions in LLM context)                                                                                                                        | Yes (deep — schema enrichment, semantic-layer cell)                                   |
| dbt / Cube / Snowflake / Databricks semantic models | No (descriptions only; skills carry method, not metric definitions)                                                                                             | Yes (semantic-model awareness across all four)                                        |
| OAuth-per-user connections / SSH tunneling          | No                                                                                                                                                              | Yes                                                                                   |

**The headline change is warehouse-free scale.** Give Hermetic an S3/HTTPS address for a Parquet dataset and it analyzes the data where it sits — Parquet footer statistics first, exact computation only on the surviving subset, and an honest `analysis_scope` disclosure when a computation had to be narrowed. The billion-row question that used to require provisioning a warehouse is now a URL paste. Hex can register S3 as a connection, but its analysis runs in Hex's cloud against data you've wired into the platform.

**Hex still wins on warehouse breadth and semantic-layer depth** — MySQL/SQL Server/Oracle/Athena, OAuth-per-user, SSH tunneling, and full semantic-model awareness remain Hex-only, and their connection-management polish keeps improving (IAM roles, refresh history, 10x Snowflake refreshes).

---

## AI / LLM Capabilities

| Feature                                 | Hermetic                                                                                                                                                                 | Hex (Hex Agent / Magic)                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| NL to complete dashboard                | Yes (one prompt → multi-widget spec)                                                                                                                                     | Partial (Agent builds notebooks/generative apps step-by-step)                                                                          |
| NL to SQL / Python / chart              | Yes (dialect-aware; 57 AI-selected chart types)                                                                                                                          | Yes (Magic SQL/Python/Chart, semantic-layer aware; R too)                                                                              |
| Multi-step agentic analysis             | Yes (Investigate: planner → parallel/serial sub-questions → composed dashboard; Notebook mode)                                                                           | Yes (Hex Agent — autonomous multi-cell workflow, now with visual self-verification via screenshots, Jul 21, 2026)                      |
| **Teachable business definitions**      | **Yes (new — skills: markdown definitions + reviewer rules + your own tested Python modules, live-reloaded from a folder, enforced per-question)**                       | Partial (workspace guides + semantic models + `design.md` brand file describe data and style; no method enforcement)                   |
| **Pre-execution code review gate**      | **Yes (new — a second model checks generated code against built-in + skill-contributed correctness rules; violations regenerate before any data is read)**               | No equivalent (agent self-verifies output visually; Evals test the agent, not each run)                                                |
| **Agent quality testing (evals)**       | No (replay fixtures + 2161 CI tests cover the pipeline, not user-authored eval suites)                                                                                   | **Yes (new — Evals, Aug 4, 2026: test questions with expected outcomes, run before publishing context changes)**                       |
| **Unbounded analysis time**             | **Yes (new — no time limit; live phase/elapsed display, up-front estimate, real stop button, laptop-sleep and browser-reload survival, results saved if you step away)** | Long agent runs supported; desktop notifications on completion (Jul 21, 2026)                                                          |
| **Follow-up context inheritance**       | **Yes (new — warehouse follow-ups inherit the previous question + query, so filters and time windows survive refinement; memory stores structure only, never values)**   | Yes (Threads carry full conversation + data context)                                                                                   |
| **Resource-use transparency**           | Yes (artifacts, per-step audit trail, methodology disclosure, `analysis_scope`)                                                                                          | **Yes (new — agent shows which guides/tables/semantic models it consulted vs used, Jul 30, 2026)**                                     |
| Multi-provider LLM                      | Yes (7 providers: Anthropic, Bedrock, Vertex, OpenAI-compat, MLX, llama.cpp, Ollama)                                                                                     | **Partial (new — model picker: Claude Opus 5, Claude Fable 5, Kimi K2.7; Hex-hosted only, no local, workspace default settable)**      |
| Local / offline LLM                     | Yes (MLX, llama.cpp, Ollama with curated hardware tiers)                                                                                                                 | No                                                                                                                                     |
| **No-API-key operation**                | **Yes (new — claude-cli transport: if the `claude` CLI is signed in, Hermetic bills the subscription; ~150 tokens overhead per call)**                                   | N/A (bundled; credits per seat)                                                                                                        |
| Per-analysis LLM cost tracking          | Yes (always-on footer, per-day CSV, `/cost` page)                                                                                                                        | Partial (credit consumption now visible/controllable: spend limits, per-user allocations, Context Studio usage via CLI — Jul 14, 2026) |
| Schema-only privacy mode                | Yes — LLM never sees data values, only schema + statistics                                                                                                               | No (data flows through Hex's AI infra)                                                                                                 |
| Failure recovery                        | Yes (retry with failed-attempt history + reflection)                                                                                                                     | Yes (agent retries with cell context)                                                                                                  |
| Code explain / debug / inline typeahead | No                                                                                                                                                                       | Yes                                                                                                                                    |

**Skills are the cycle's biggest capability divergence.** A skill folder teaches Hermetic your fiscal calendar, your definition of "active customer," your tested statistical methods — and the pre-execution review gate _enforces_ them: generated code that violates a rule (average-of-averages, dropped exclusions, sample-as-population) is regenerated before it ever touches data. Hex's context system (guides, semantic models, and now Evals) is genuinely converging on the teaching half — Evals even let you test whether context changes helped — but nothing in Hex rejects a wrong-but-valid analysis before it runs. Hex verifies the agent statistically; Hermetic verifies each analysis mechanically.

**Hex's agent had a strong summer too, and it deserves plain credit.** The Hex Agent escaped the browser (CLI and API access with cell outputs, Jul 30), learned to screenshot its own generative apps and fix visual defects before delivery, discloses which resources it consulted, and gained a real model picker. The "Hex chooses your model" row from prior editions is now stale — though the picker is cloud-hosted models only, so the local/BYO axis still belongs to Hermetic, as does the exact-dollar cost meter (Hex's equivalent is credit-consumption dashboards).

**Where each still wins:** Hex on iterative code-craft (Magic Explain/Debug, R, typeahead, the multiplayer notebook loop) and now on agent evaluation tooling; Hermetic on autonomy, privacy (schema-only context is still architecturally unique in this pairing), enforcement, and cost transparency.

---

## Visualization

_The 57-type native chart library is unchanged since 2026-06-20 — see that edition for the full family-by-family table (statistics, ML, hierarchical, network/flow, financial, scientific/temporal, 3D/geo families all native and AI-selected). Summary rows only:_

| Feature                                                                   | Hermetic                                                                                                                                     | Hex                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Native chart types                                                        | 57 (AI-selected from spec; incl. Sankey, SHAP, ROC, Kaplan–Meier, candlestick)                                                               | ~14 built-in chart-cell types; anything else via Python/R |
| No-code chart creation                                                    | AI-driven (fully automatic)                                                                                                                  | Drag-and-drop builder + Magic Chart + agent chart cells   |
| Statistics family (Pareto, QQ, ECDF, survival, SPC, forest, correlogram)  | Yes (native)                                                                                                                                 | Via Python                                                |
| ML family (confusion, ROC, SHAP, calibration, lift/gain, PDP, silhouette) | Yes (native)                                                                                                                                 | Via Python                                                |
| Network & flow (Sankey, chord, stream, network graph)                     | Yes (native)                                                                                                                                 | Via Python                                                |
| Comparison & KPI (waterfall, marimekko, bullet, funnel, gauge, dual-axis) | Yes (native)                                                                                                                                 | Via Python                                                |
| 3D (globe, deck.gl layers, Plotly 3D)                                     | Yes (native, interactive)                                                                                                                    | Via Python (no globe/deck.gl)                             |
| Geographic (2D maps, choropleth)                                          | Yes (MapLibre GL)                                                                                                                            | Via Folium / Plotly                                       |
| Interactive pivot tables                                                  | Yes (drill, cross-filter, heatmap mode, multi-aggregator)                                                                                    | Yes (Pivot cell)                                          |
| Data tables / stat cards                                                  | Yes (sort/filter/paginate; StatCard + TrendIndicator)                                                                                        | Yes (tables with sparklines; Single value cell)           |
| **Viewer parity outside the web app**                                     | **Yes (new — the MCP embedded viewer renders the same `<SpecView>`, themes, dark mode, and Geist typography as the web app, loopback-only)** | N/A (one surface — the Hex cloud app)                     |
| Code-based charts                                                         | Sandbox Python (matplotlib, plotly, seaborn)                                                                                                 | Full Python/R environment (any library)                   |

**Hermetic still wins on out-of-the-box chart diversity; Hex still wins on unlimited customization.** The new fact this cycle is that Hermetic's renderer now travels: the identical dashboard renders in the web app, the MCP viewer, and (below) a standalone exported file.

---

## Agent Interoperability (new category)

_Both products now expose themselves to AI agents. The architectures could hardly be more different._

| Feature                             | Hermetic                                                                                                                                                                                                                                          | Hex                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| MCP server                          | **Yes (new — local stdio server; nine tools; any MCP host becomes a front end)**                                                                                                                                                                  | Yes (remote, `app.hex.tech/mcp`, OAuth; live since Oct 29, 2025 — newly surveyed here)               |
| Tool surface                        | `analyze` (full pipeline in one call), `connect_source`, `get_schema`, `run_sql`, `run_analysis`, `verify_narrative`, `persist_dashboard`, `export_dashboard`, `list_sources`                                                                     | Search projects, create/get/continue threads — the agent delegates the question to Hex's cloud agent |
| Where analysis executes             | Locally — Docker sandbox on your machine; results return as aggregates                                                                                                                                                                            | Hex's cloud (every interaction backed by a Hex notebook)                                             |
| Agent CLI / API                     | MCP + `hermetic` CLI (render, etc.)                                                                                                                                                                                                               | **Yes (new — Hex Agent via CLI and API with cell outputs, Jul 30, 2026)**                            |
| Acting as an MCP _client_           | No                                                                                                                                                                                                                                                | Yes (May 28, 2026 — agent reads strategy docs, notes, Slack via external MCP servers)                |
| Slack surface                       | No (drop an exported .html into Slack manually)                                                                                                                                                                                                   | Yes (@Hex in-channel, answers in-thread, since Oct 2025)                                             |
| Setup                               | One command (`scripts/install-mcp.sh`); zero-step in Claude Code via the repo's `.mcp.json`                                                                                                                                                       | OAuth sign-in; requires Explorer+ seat on Team/Enterprise plans                                      |
| Trust model for agent-authored work | Documented guards on authorship: hardened read-only SQL gate (DML-in-CTE and EXPLAIN ANALYZE closed) + engine-level readonly backstops; host-authored Python runs network-denied unconditionally; host-authored specs validated in enforcing mode | Workspace permissions + Hex's cloud security model                                                   |
| Egress control                      | Analysis containers on a no-outbound-route Docker network; only door is a proxy allowlisted to the analyzed bucket's hosts; CI proves it with a permanent exfiltration canary (mutation-tested)                                                   | N/A (execution is in Hex's cloud by design)                                                          |
| Boundary honesty                    | Documented: data plane local; every row-bearing response capped; audit log (`data/mcp-audit.jsonl`) with sanitized args; credentials never cross on any path                                                                                      | Data flows through Hex cloud + chosen model provider                                                 |
| RPC hygiene                         | Closed error taxonomy (machine-readable codes, e.g. `source_expired` names the re-attach call), contract versioning, flagged truncation, streamed progress notifications                                                                          | Standard API/MCP responses                                                                           |
| Local-model agent path              | Yes (a local-model MCP client keeps everything on-machine; tools behave identically)                                                                                                                                                              | No                                                                                                   |

**Same protocol, opposite philosophies.** Hex's MCP server is a door _into_ Hex: your agent asks, Hex's cloud agent analyzes data already in the platform, and the artifact lives in Hex — a natural extension of a SaaS. Hermetic's MCP server is a toolbox brought _to_ the agent: nine local tools, execution in the local sandbox, data staying home, and the dashboard persisted on your disk with a viewer link that works with nothing else running. Hermetic also lets the agent do things Hex's thread-delegation model doesn't expose: run its own Python in a governed sandbox, verify every number in its prose against computed values (`verify_narrative`), and author dashboard specs directly (validated in enforcing mode). One consequence worth naming: Claude Desktop users could never run Hermetic before; now the desktop app is a front end, with no API key via the subscription transport. Hex counters with breadth of surfaces — browser, Slack, CLI, API, MCP, even a Figma connector (Jun 25, 2026) — that Hermetic doesn't try to match.

_Engineering-maturity note: the MCP wave shipped through a principal-engineer-style review pass — 2161 CI tests including the mutation-tested egress canary, plus a pre-merge flow review that caught two correctness bugs and a credential leak before release._

---

## Interactive App Building

| Feature                                                        | Hermetic                                                      | Hex                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Input widgets                                                  | SelectControl, NumberInput, ToggleSwitch, TextInput, TextArea | Full suite (dropdowns, sliders, date pickers, multi-select, file upload, …)                           |
| Reactive state / filtering                                     | Yes (DataController pipelines, cross-chart filtering)         | Yes (cell dependency graph, reactive re-execution)                                                    |
| Layout builder                                                 | AI-generated (LayoutGrid/Row/Column)                          | Drag-and-drop App Builder + **generative apps** (agent-built; direct code editing added Jul 21, 2026) |
| App publishing                                                 | No hosted publishing — **but see single-file export below**   | Yes (standalone web app, dashboard, embedded report; CSV downloads in generative apps Jul 21)         |
| Workspace-wide app styling                                     | 4 themes × light/dark                                         | Custom CSS/fonts per app + `design.md` brand guidelines (Jul 8, 2026)                                 |
| Button triggers / conditional visibility / reusable components | No                                                            | Yes                                                                                                   |

**Hex's app story graduated from hand-built to agent-built.** Generative apps — the agent authoring an app, screenshotting it to self-check, honoring a workspace `design.md` — are the App Builder's next act, and direct code editing (Jul 21) removed the prompt-only friction. Hermetic still composes an interactive dashboard from one question with zero building, and its answer to "publishing" now lives in the next section rather than in a hosted-apps roadmap.

---

## Collaboration, Sharing & Operations

| Feature                       | Hermetic                                                                                                                          | Hex                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Real-time multiplayer editing | No                                                                                                                                | Yes (Google Docs-style)                                                                   |
| Comments / threads            | No                                                                                                                                | Yes (Threads, AI-aware)                                                                   |
| Version history               | Yes (per-viz versions)                                                                                                            | Yes (full, with restore/fork)                                                             |
| Git integration               | No                                                                                                                                | Yes (Enterprise)                                                                          |
| RBAC / workspace organization | No                                                                                                                                | Yes (roles incl. Explorer seats; role-request controls Jul 14, 2026)                      |
| Published apps                | No hosted apps — **single-file HTML export instead (below)**                                                                      | Yes (cloud-hosted; workspace permissions; public web links on paid plans)                 |
| Scheduled runs (cron)         | Yes (node-cron, edit-in-place schedule pills)                                                                                     | Yes (with email/Slack delivery)                                                           |
| Persistent analysis history   | Yes (every analysis on disk, survives restarts; MCP-created entries share the same store)                                         | Yes (project history + version control)                                                   |
| Cost & observability          | Yes (per-analysis cost, per-day CSV, `/cost`; **new — MCP audit log + run-id observability joining tool calls to pipeline runs**) | Yes (credit dashboards, spend limits, per-user allocations, usage via CLI — Jul 14, 2026) |
| Embed in other tools          | No (exported .html can be attached anywhere, incl. Slack/Notion/drives, as a file)                                                | Yes (signed embedding, custom theming)                                                    |
| API-triggered runs            | Yes via MCP tools (`analyze` from any MCP host or script)                                                                         | Yes (REST API + agent API)                                                                |
| Email / Slack delivery        | No (scheduled runs stay local)                                                                                                    | Yes                                                                                       |
| Review workflows              | No                                                                                                                                | Yes (Draft / In Review / Published)                                                       |

**Hex still wins decisively on team collaboration** — multiplayer, threads, review workflows, RBAC, and automated delivery are a mature team product Hermetic does not attempt. What changed is the _sharing_ half of this category: Hermetic's answer is no longer "nothing," it's a file (next section), and MCP quietly closed the "API-triggered runs" gap that every prior edition scored as a flat No.

---

## Export & Distribution

| Feature                                  | Hermetic                                                                                                                                                                                                 | Hex                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Single-file interactive dashboard**    | **Yes (new — ONE self-contained .html: spec, data, renderer, charts, themes, fonts inlined; opens from file://, offline forever; full Tier-2 interactivity — filters, cross-filter, drill, parameters)** | No (apps are cloud-hosted; interactive export is PDF-static only — no public changes found) |
| Export surfaces                          | **Every harness (new): web export menu, `hermetic render <id> --html`, MCP `export_dashboard` tool + `export_url` on every `analyze`, viewer Download button**                                           | Cloud app                                                                                   |
| Size honesty                             | ~2.8MB standard bundle / ~10.6MB full (heavy chart families only when used; exporter prints the breakdown)                                                                                               | N/A                                                                                         |
| Export governance                        | `__`-internal state stripped, as-of watermark, exposure line; manifest carries a credential-free reconnection recipe                                                                                     | Workspace permissions                                                                       |
| PDF / DOCX / PPTX / XLSX / PNG / CSV     | Yes (all; multi-sheet styled XLSX; notebook → Markdown/HTML/PDF/Slides)                                                                                                                                  | PDF, PNG, CSV (CSV in generative apps added Jul 21, 2026)                                   |
| Shareable links                          | Local viewer links; the shareable unit is the file                                                                                                                                                       | Yes (cloud links; public web sharing on paid plans)                                         |
| Scheduled email reports / Slack / embeds | No                                                                                                                                                                                                       | Yes                                                                                         |

**This is the cycle's direct competitive strike.** "I can't show this to a colleague" had been on Hermetic's own gap list since April 2026 ([competitive-feature-gaps](../specs/archive/competitive-feature-gaps-2026-04-25.md), item 8). The answer that shipped today inverts Hex's model instead of copying it: the dashboard **is** the file. Drop it in Slack, email it, AirDrop it, put it on a shared drive — it opens on any device with a browser, with no Hex workspace, no seat, no login, no link that can rot, no server that can be down, and it still works in five years on an airplane. Every export carries the verbatim question and an "ask your own question" footer, so the artifact is also the demo. Hex's sharing runs through Hex cloud by design: internal viewers need workspace access (Explorer seats are the read-focused paid add-on on Team/Enterprise), public sharing is a hosted web link on paid plans, and the only offline artifact is a static PDF — no public changes found on any of this June → August. The honest counterweights: a Hex link always shows current data while an exported file is a governed snapshot (as-of watermark; live-reconnection is a credential-free recipe, and DuckDB-WASM Parquet snapshots for warehouse-scale files remain v2), and Hex's _automated_ distribution — scheduled email/Slack delivery, signed embeds — has no Hermetic equivalent.

---

## Code & Transparency

| Feature                            | Hermetic                                                                                            | Hex                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| View / edit generated SQL + Python | Yes (Artifacts panel; edit-and-rerun re-executes downstream)                                        | Yes (full cell editing + Magic Edit)           |
| Notebook view                      | Yes (Investigate Notebook mode, exportable)                                                         | Yes (native)                                   |
| **Pre-execution review**           | **Yes (new — reviewer model + skill rules gate code before it touches data)**                       | No per-run gate (Evals test the agent offline) |
| **Narrative verification**         | **Yes (new — `verify_narrative` traces every number in prose to computed values)**                  | No (cell outputs are inspectable)              |
| SQL / Python / R cells             | No first-class cells (edit-and-rerun on generated code); R: no                                      | Yes (full IDE, R, typeahead, pip install)      |
| **Reusable logic**                 | **Yes (new — skills ship tested Python modules the generated code imports instead of re-deriving)** | Yes (Components, Magic templates)              |
| Audit trail                        | Yes (artifacts, methodology, scope disclosure, cost; MCP calls in a sanitized audit log)            | Yes (cells + version history)                  |

**Hex still wins on full code flexibility; Hermetic still wins on verification.** The reusable-logic row flipped this cycle — skills' tested-helper modules answer a long-standing Hex-only advantage, with the twist that Hermetic's version is enforced by the review gate rather than merely available.

---

## Privacy & Deployment

| Feature                        | Hermetic                                                                                                                                                                     | Hex                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Self-hosted / air-gapped       | Yes (Docker + local LLM)                                                                                                                                                     | No (single-tenant Enterprise hosting only)                                                |
| LLM never sees row data        | Yes (schema + stats only)                                                                                                                                                    | No (data flows through Hex AI infra; Fable 5 model even requires a data-retention opt-in) |
| **No API key required**        | **Yes (new — claude-cli subscription transport)**                                                                                                                            | N/A (SaaS login)                                                                          |
| **Sandbox egress control**     | **Yes (new — host-authored code: network denied unconditionally; cloud-analysis containers: no outbound route except a bucket-scoped proxy; CI-proven exfiltration canary)** | N/A (cloud execution model)                                                               |
| **Read-only SQL enforcement**  | **Yes (new — hardened code-level gate incl. DML-in-CTE and EXPLAIN ANALYZE closure, plus engine-level readonly backstops per connector)**                                    | Warehouse credentials scoped by the admin                                                 |
| Open source / no lock-in       | Yes (MIT, standard formats)                                                                                                                                                  | No (proprietary)                                                                          |
| BYO LLM                        | Yes (7 providers + local)                                                                                                                                                    | Model picker (cloud-hosted only); BYO on Enterprise                                       |
| SOC 2 / SSO / audit logs / VPC | N/A / No / MCP + cost logs / No                                                                                                                                              | Yes on Team–Enterprise tiers                                                              |

**The trust model is now documented, not just implied.** August's MCP work forced precision: guards sit on _authorship_ (who wrote the SQL/Python/spec), the data plane stays local, whatever crosses to a host is bounded, capped, and audit-logged, and credentials never cross on any path. Hex remains the right answer for organizations that want a vendor to own compliance (SOC 2, SSO, VPC) rather than run infrastructure.

---

## Pricing Comparison (August 2026)

|                     | Hermetic                                                  | Hex Community   | Hex Professional       | Hex Team                                                                    | Hex Enterprise |
| ------------------- | --------------------------------------------------------- | --------------- | ---------------------- | --------------------------------------------------------------------------- | -------------- |
| **Price**           | Free (OSS)                                                | $0              | ~$36/editor/mo         | ~$75/editor/mo (+ Explorer seat add-on)                                     | Custom         |
| LLM access          | BYO key, local model, or **Claude subscription (no key)** | Bundled credits | Per-seat credit grants | Per-seat credit grants + add-on credits, spend limits, per-user allocations | Custom         |
| Cost visibility     | Exact per-analysis dollars (footer + CSV + `/cost`)       | Credit meter    | Credit meter           | Credit dashboards + caps (Jul 14, 2026)                                     | Custom         |
| Agent surfaces      | Web, CLI, any MCP host                                    | Browser         | Browser, CLI/API       | + Slack, MCP (Explorer+ seats)                                              | All            |
| Sharing a dashboard | A file — free, no recipient seat, offline                 | Workspace       | + public web links     | + Explorer seats for internal viewers                                       | Custom         |

**Published seat prices are unchanged since May ($36/$75 verified 2026-08-05); what moved is the credit economy.** Hex's July releases were substantially about metering the agent — spend limits, per-user allocations, usage analytics via CLI — a tacit acknowledgment that agent compute is a real line item. Hermetic's equivalent motion went the other way: the claude-cli transport means many users' marginal cost is a subscription they already pay, with the exact per-analysis dollar figure still on screen. Distribution economics are now part of the pricing story too: sharing a Hermetic dashboard costs nothing and requires nothing of the recipient; sharing a Hex app internally is what Explorer seats are for.

---

## What's New Since the Previous Version of This Comparison

**On the Hermetic side (since 2026-06-20):**

- **July wave** — cloud Parquet on S3/GCS/HTTPS analyzed in place at ~2.5B-row scale (metadata pruning → coarse-to-fine, honest scope disclosure); **skills** (business definitions + reviewer rules + tested Python modules, enforced); **pre-execution code review gate**; analysis time limit removed (progress, estimate, stop, sleep/reload survival); **claude-cli subscription transport** (no API key, ~150-token overhead); warehouse follow-ups inherit prior question + query; schema caching; home page redesigned around the question.
- **August wave** — **Hermetic is an MCP server**: nine tools (`analyze` flagship; `connect_source`, `get_schema`, `run_sql`, `run_analysis`, `verify_narrative`, `persist_dashboard`, `export_dashboard`, `list_sources`), embedded viewer at full visual parity, documented authorship-based trust model (hardened read-only SQL gate, unconditional network-deny for host code, bucket-scoped egress allowlist with a CI-proven, mutation-tested exfiltration canary), closed error taxonomy + contract versioning, run-id observability, sanitized audit log, one-command installer + zero-step Claude Code via `.mcp.json`. Shipped through a principal-engineer review pass (2161 tests).
- **Today (2026-08-05)** — **single-file interactive HTML export** from every surface (web menu, `hermetic render --html`, MCP `export_dashboard`/`export_url`): one self-contained ~2.8MB (standard) / ~10.6MB (full) .html, offline forever, Tier-2 interactive, governed (state-strip, as-of watermark, exposure line), self-demonstrating footer. v2 (DuckDB-WASM Parquet snapshots for warehouse scale) remains open.

**On the Hex side (verified via [changelog](https://learn.hex.tech/changelog) and [blog](https://hex.tech/blog/introducing-agent-in-slack-and-mcp/), 2026-08-05):**

- **Aug 4, 2026** — **Evals**: test questions with expected outcomes, run against the agent before publishing context changes.
- **Jul 30, 2026** — **Hex Agent via CLI and API** (with cell outputs); resource-usage transparency (consulted vs used); **Claude Opus 5** in the model picker; 10x faster Snowflake schema refreshes.
- **Jul 21, 2026** — generative apps: direct code editing, CSV downloads, agent visual self-verification via screenshots; desktop notifications.
- **Jul 14, 2026** — credit governance: spend limits, per-user credit allocations, usage analytics via CLI, role-request controls.
- **Jul 8, 2026** — model picker additions (Kimi K2.7, Claude Fable 5 — the latter requiring data-retention opt-in), workspace default model, `design.md` brand guidelines.
- **Jun 25, 2026** — Figma connector, AWS IAM role auth (Athena/Redshift/RDS/S3/ECR), schema refresh history.
- **Newly surveyed (predates this window)** — Hex's remote **MCP server** + Slack integration (Oct 29, 2025; Explorer+ on Team/Enterprise; thread-delegation model) and Hex as an **MCP client** (May 28, 2026).
- **No public changes found** on: seat pricing ($36/$75 confirmed), the cloud-hosted app sharing model, or any offline/file-based interactive export.

---

## Summary: When to Choose Each

### Choose Hermetic when:

- You want **question to dashboard in seconds** with zero coding, or a **multi-step deep-dive** via Investigate
- **Data privacy is non-negotiable** — the LLM never sees your rows, execution is sandboxed with proven egress control, and air-gapped operation works
- You want your **agent to have an analysis room**: Claude Desktop/Code (or any MCP host) driving nine local tools, with data staying home and dashboards outliving the chat
- You want to **share a dashboard as a file** — one interactive .html, no recipient accounts, no infra, offline forever
- You have **billion-row Parquet on S3** and no warehouse (or no desire to build one)
- You want the tool to **learn and enforce your business definitions and methods** (skills + review gate)
- You want **BYO/local models** or to run on the **Claude subscription you already pay for** — with exact per-analysis cost
- You want **rich document exports** (PPTX, DOCX, styled XLSX, notebook → Slides) and 57 AI-selected chart types
- You're a **solo analyst or small team** without collaboration needs, and want zero vendor lock-in

### Choose Hex when:

- You need a **collaborative analytics platform** — multiplayer editing, Threads, review workflows, RBAC, Collections
- You want **hosted, always-current apps** with scheduled email/Slack delivery, signed embeds, and public web links
- Your agent should be **where your team already is** — browser, Slack, CLI, API, MCP — and you want **Evals** to hold it to a quality bar
- You need warehouse coverage beyond Hermetic's seven (MySQL, SQL Server, Oracle, Athena) or OAuth-per-user / SSH tunneling
- You want a **full Python/R/SQL IDE** with typeahead, Magic Explain/Debug, and generative apps with direct code editing
- You need **deep semantic-layer integration** (dbt MetricFlow, Cube, Snowflake, Databricks)
- You need **enterprise compliance** (SOC 2, SSO, audit logs, VPC) from a managed vendor

### The Fundamental Difference

**Hermetic** is an **AI-first, local-first analysis engine** that now presents three faces: a web app that turns a question into a dashboard, an MCP toolbox that turns any agent into a private analyst, and — as of today — a file format that turns any dashboard into its own distribution. The LLM never sees a row; skills and a review gate hold every analysis to your rules; and the artifact travels without infrastructure.

**Hex** is an **AI-augmented cloud platform for data teams** whose agent now reaches every surface a team works in — notebook, app, Slack, terminal, API, MCP — with the collaboration, governance, and delivery machinery of a mature SaaS around it.

The two new axes this edition tracks cut in opposite directions, and both are real. On **agent interop**, both ship MCP — but Hex's server invites your agent into its cloud, while Hermetic's brings the analysis to your machine; which is right depends entirely on where your data is allowed to go. On **distribution**, Hex's answer is a better-hosted link; Hermetic's is that there is nothing to host. Hermetic is for "give me the answer privately, let my agent ask too, and let me hand anyone the result as a file." Hex is for "help my team find, ship, and operate the answer together." The products are converging on the agent era from opposite shores — and for the first time, Hermetic's sharing story is an argument rather than an apology.

---

## Sources (Hex side, checked 2026-08-05)

- [Hex changelog](https://learn.hex.tech/changelog) — Evals (Aug 4), Agent CLI/API + resource tracking + Opus 5 + Snowflake refresh (Jul 30), generative-app editing/CSV/visual verification + desktop notifications (Jul 21), spend limits + per-user credits + Context Studio CLI + role controls (Jul 14), Kimi K2.7 + Fable 5 + workspace default model + design.md (Jul 8), Figma connector + AWS IAM roles + refresh history (Jun 25)
- [Hex Agent, everywhere: Slack integration and MCP support](https://hex.tech/blog/introducing-agent-in-slack-and-mcp/) (Oct 29, 2025) — remote MCP server (search projects, create/get/continue threads), OAuth, Explorer+ seats on Team/Enterprise, "every interaction is backed by a Hex notebook"
- [Hex as MCP client](https://learn.hex.tech/changelog/2026-05-28) (May 28, 2026)
- [Hex pricing](https://hex.tech/pricing/) — Community $0 / Professional $36 / Team $75 / Enterprise custom; Editor + Explorer seat types; per-seat credit grants; compute $0.32–$4.06/hr for advanced profiles
- [Publish and share Apps](https://learn.hex.tech/docs/share-insights/apps/publish-and-share-apps) — Can View App permissions; PDF is the only offline export found
- Hermetic-side claims verified in-repo: [docs/mcp.md](../docs/mcp.md), [specs/dashboard-distribution-2026-08-05.md](../specs/dashboard-distribution-2026-08-05.md) (v1 implemented, commit `c0222ab`: 2.8MB/10.6MB profiles, three surfaces), [specs/mcp-server-proposal-2026-08-04.md](../specs/mcp-server-proposal-2026-08-04.md), July/August release notes; test count (2161) and egress-canary claims verified against commit messages (`c0222ab`, `9241129`, PR #96)

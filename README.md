# Hermetic

Hermetic is an open-source, local-first AI data analyst: ask questions of your data in natural language and get interactive dashboards, without the model ever seeing your rows.

- **Sources**: CSV, Excel, GeoJSON, and Parquet files (single files, Hive-partitioned folders, and cloud Parquet on S3/HTTPS at billion-row scale) — or direct connections to PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, and Hive.
- **Analysis**: single-question dashboards, conversational follow-ups, and a multi-step **Investigate** agent; every narrative number is checked against what the analysis actually computed.
- **Honest by construction**: the analysis **declares its findings and checks as typed claims**, a tested statistical runtime applies regime-aware judgment (zero sentinels, thin-data attestation, robust-test dispatch) as **total functions rather than model discretion**, and an optional **compiled composer** writes the narrative and builds the dashboard deterministically from those claims — analyst prose in which every figure is a binding, fabrication unrepresentable. A Verify panel and an on-demand adversarial audit show the receipts.
- **Editable results**: compiled dashboards are live documents — reorder sections, hide/show elements, edit the insight paragraph, narrate an un-told claim, or add charts from a derived catalog, all through one governed edit grammar shared by the web UI and MCP.
- **Teachable**: drop-in **skills** (markdown guidance + tested Python helpers) carry your team's definitions and methods, enforced by a pre-execution review gate — and a curated **learning** loop keeps exemplars from past successful runs (lint-flagged runs are vetoed from teaching).
- **Durable**: analyses persist, restore, re-run against fresh data, refresh on a cron, and export — including as a **single self-contained interactive HTML file** you can share anywhere. Views are URL-addressable; a results link reconstructs the analysis.
- **Agent-ready**: hermetic is also an **MCP server** — Claude Desktop, Claude Code, or any MCP host can drive the same pipeline as tools (including auditing and editing dashboards) while data and execution stay on your machine.
- **Models**: cloud LLMs (Anthropic, AWS Bedrock, Google Vertex, OpenAI-compatible — the Claude 5 family selectable per task), your own Claude subscription via the Claude CLI (no API key), or local models via MLX, llama.cpp, or Ollama, with per-phase reasoning-effort control.

![Home screen with file upload, warehouse connect, and saved connections](docs/home.png)

![Ask screen with LLM-generated question suggestions](docs/ask-suggestions.png)

![Dashboard with scatter chart, radar chart, insights, and statistical test](docs/dashboard.png)

![Artifacts panel with syntax-highlighted SQL query](docs/artifacts.png)

![Data explorer rail with table list, schema, and sample data](docs/data-explorer.png)

![Settings drawer with themes, mode toggle, and connected sources](docs/settings.png)

![Saved visualizations with load, update, and delete actions](docs/saved-vizs.png)

## Philosophy

Hermetic explores the idea that LLMs can generate correct data analysis code **without seeing the data itself**.

**Shape over samples.** Instead of sending rows to the LLM, Hermetic extracts the schema (column names, types, distributions, ranges, cardinality, correlations) and shares only that metadata as context. The LLM never sees actual data rows by default. This keeps data private, reduces token usage, and forces the model to reason about structure rather than memorize values.

**Blind execution.** The LLM generates Python code but never sees the results. Code runs in an isolated sandbox (Docker, microVM, or cloud), and the execution output (scalars, chart data, datasets) flows directly to the UI composition step. The LLM composing the dashboard works from result schemas and placeholders, not raw numbers. Every number displayed comes from actual computation on the real data. (A **composer sight** setting can optionally let the composer see computed values to sharpen phrasing — the binding discipline is unchanged either way, and the Verify panel records which mode ran.)

**Claims, not prose.** The generated analysis doesn't just compute — it **declares** what it found. `declare_finding` records each claim (name, typed value, plain-language definition) adjacent to the computation that produced it; `declare_check` records the data-quality checks the model designed for this dataset, with computed evidence, executed as code; `declare_series`/`declare_value` declare the chart data with **roles** (which column is time, which are measures, their units, the observation count, the raw-vs-screened variants, and how a measure re-aggregates from the source table — the recipe that lets a dashboard filter honestly instead of guessing). Narrative binds these claims (`$finding:` placeholders resolved server-side) instead of restating them, a lint battery cross-checks prose, results, charts, and claims against each other, and anything shipped that points at a declaration which doesn't exist — a cited finding, an executed screen, a methodological decision — is flagged or repaired before it reaches you.

**Statistics as total functions.** The judgment calls that make analyses subtly wrong — is a `$0.00` price a real value or an unrecorded-value sentinel? can a 52-observation year headline a series whose typical year has 600? is the mean valid under this skew? which correlation coefficient survives these ties? — are not left to per-run model discretion. A tested statistical runtime (`docker/sandbox/hermetic_runtime`) profiles every declared series into a **regime profile** (zero inflation, heavy tails, contamination, count skew, thin edges, short series, ties…), and a closed **regime matrix** — every claim type × every regime, all cells explicit, the rendered table generated from the code and drift-pinned by tests — maps each hazard to its response. Where possible the response is enforced _inside_ the claim function: sentinel zeros are excluded automatically when a measure's unit is monetary, trends become count-weighted least squares when observation counts exist, heavy-tailed group comparisons dispatch to Kruskal–Wallis, provably disordered series are refused rather than fit, and thin periods are gated by a relative attestation bar. The claim layer cannot disagree with the declared policy, and identical data cannot produce different verdicts run to run.

**Sandboxed execution.** Code runs in containers or microVMs with no access to the host filesystem. Docker containers run with networking disabled (`--network none`) by default; network is enabled only when the generated code actually reads a remote data source (cloud Parquet over `s3://`/`https://`), and those runs use a fresh ephemeral container rather than the shared warm one. Data is passed in via stdin and results are read from stdout. Warm sandbox modes (Docker, Microsandbox) reuse the underlying container across queries for speed but clear working data between runs. E2B creates a fresh cloud sandbox each time (network posture is E2B's).

**Adaptive UI, two composer architectures.** Dashboards are declarative render specs (an owned, vendored fork of JSON-Render — `src/spec`): charts, stat cards, tables, annotations, and filters tailored to each question. Two composers can produce that spec, selectable in Settings:

- **Generative** (default): the LLM composes the layout freely from result schemas, with the lint battery and a bounded repair pass guarding the output.
- **Compiled**: one small LLM call **writes the document** — flowing analyst prose in which every figure must be a `$finding:` binding — and everything else is compiled deterministically. The plan is a typed grammar of speech acts (ANSWER / TREND / PEAK / ENDPOINT / CONTRAST / CAVEAT / INSIGHT) plus document structure (SECTION headings, chart EXPLAINERs, CALLOUTs, METHOD, CONCLUSION, NEXT_STEPS, LIMITS), and any node can **anchor** a chart so explainers sit above their figure and caveats sit exactly where they apply. A literal digit outside a binding is rejected; a caveat can only reference a declared check, so a fabricated mechanism has no syntax to exist in. When a node fails validation, **only that node degrades** to its template — the document survives. Charts derive from the declared series' roles via a **view catalog** (group matrices, unit-split axes, coverage companions forced in when thin-data regimes fire, precision tables for document styles), pair into two-column rows, carry human legend labels, and — when the analysis declares how a measure aggregates — come with **verified interactive filters** (below). Every style, however brief, carries the answer, its method, and a conclusion. Compiled dashboards are also what the editing surface edits. The block-by-block walkthrough is below.

## The compiled path, block by block

The organizing idea: **one small LLM call decides what to say; everything that decides whether it's true is code.**

```
question ──► ANALYSIS (LLM writes Python)
                │  declare_finding / declare_check / declare_series
                ▼
          SANDBOX RUN (model never sees rows)
                │  envelope: claims + regimes + series + results
                ▼
          PLAN CALL (the one narrative LLM call)
                │  sees projections only — names, definitions, field names
                ▼
          COMPILER (deterministic)
                │  templates + riders + charts + caveats, all $finding: bindings
                ▼
          FINALIZER / RESOLVER (deterministic)
                │  bindings → real values, units, shapes rendered as prose
                ▼
          POST-RENDER INVARIANTS ──► document / persist / edit
```

**Block 1 — The analysis declares claims.** Code generation produces a Python script that doesn't just compute — it _declares_. `declare_finding` records each claim with a name, typed value, and plain-language definition, right beside the computation. The statistical judgment inside those helpers isn't the model's: the runtime (`docker/sandbox/hermetic_runtime`) profiles every series — zero inflation, heavy tails, thin edges — and the regime matrix dispatches: Kruskal–Wallis under heavy tails, count-weighted trends, sentinel-zero exclusion for money. A helper that looked and found nothing says so in the value (`"detected": false`). The envelope that leaves the sandbox is the whole truth the rest of the pipeline is allowed to use.

**Block 2 — The projection decides what the narrative model may see.** `src/lib/findings/project.ts` strips every value, keeping names, definitions (numeral-scrubbed), and _field names_ — minus booleans (a flag has no word for a sentence slot) and minus everything on a non-detection (nothing left to misuse). This is the privacy boundary and the truthfulness boundary in one: the planner can't leak values it never had, and can't fabricate around numbers it was never offered.

**Block 3 — One LLM call writes the plan.** `src/lib/compose/planner.ts` sends the question, the projections, and the shipped chart ids, and gets back a typed program: ANSWER / TREND / EXPLAIN / CAVEAT / INSIGHT / METHOD / CONCLUSION nodes, each with refs and authored prose in which **every figure must be a `$finding:` binding** — a literal digit is a validation error. `plan.ts` validates structurally: exactly one ANSWER, every ref resolves, CAVEATs may only reference checks, boolean bindings rejected. A failed node degrades individually (salvage); only total wreckage falls back to the deterministic default plan. This is the quarantine: the model's generative act is ~10 nodes of prose with holes where the numbers go.

**Block 4 — The compiler builds the document, no LLM.** `src/lib/compose/compile.ts` walks the plan: failed-check banner first, headline tiles, one element per node with stable ids (so edits survive re-runs), charts derived from the declared series' roles, anchored under their EXPLAINs, filters wired from declared aggregation recipes. `realizer.ts` supplies text where the planner didn't — and appends **riders** to text where it did: catch-all disclosure, relaxed attestation bar, excluded-trailing, thin-groups, zero-screen. Authored prose can replace a template's headline sentence; it cannot suppress a disclosure.

**Block 5 — Resolution makes the numbers real.** The document so far contains no data — just bindings. The finalizer (`src/lib/llm/resolve-placeholders.ts`) substitutes each `$finding:` against the envelope: currency gets 2dp and separators, units attach by declared identity, and non-scalar values go through the value renderer — intervals as "−11.15 to 11.51", mappings ranked with the minimum named. A genuinely unspeakable value drops its token, never its sentence. This is the same resolution stack generative mode uses, so there is exactly one path to trust.

**Block 6 — Invariants, then the record.** After finalization, the pipeline re-checks the rendered document: any plan node that resolved empty degrades to its deterministic template; an ANSWER empty even then is a recorded structural failure — the document never ships answer-less. The grounding verifier counts declared-vs-cited claims and untraceable figures into the Verify panel; an on-demand adversarial audit reads the whole thing back. Then everything persists — spec, plan, code, envelope — which is why edits recompile the same plan instead of re-asking the model, and why a restore replays the identical document.

The failure philosophy stitching the blocks together: each one makes a class of lie _unrepresentable_ rather than detected — no rows in the model's context (1), no numbers in the planner's hands (2), no syntax for a fabricated caveat (3), no suppressible disclosure (4), no unformatted or dangling value (5), no empty answer (6). The defects that do slip through live at the _seams between blocks_ — a projection offering the wrong field, a resolver refusing a speakable value — which is why the audit trail (`specs/`) keeps landing fixes at boundaries rather than inside any single block.

## Quick Start

```bash
git clone https://github.com/achalp/hermetic.git
cd hermetic
./start.sh
```

The setup script checks prerequisites, installs dependencies, sets up your chosen sandbox runtime, and starts the dev server. It will prompt you for an API key and let you choose between Docker and Microsandbox. For CI or scripted setups, `./start.sh --headless` (or `-y`) accepts defaults and skips every interactive question.

It also offers to connect hermetic to Claude Desktop / Claude Code as an MCP server — see [Using from Claude](#using-from-claude-mcp-server).

### Manual Setup

1. **Install dependencies**

   This project uses [pnpm](https://pnpm.io). Enable it with Corepack (bundled with Node), then install:

   ```bash
   corepack enable
   pnpm install
   ```

   The committed `pnpm-lock.yaml` is registry-agnostic, so it installs cleanly against the public npm registry or a corporate mirror (e.g. Artifactory) configured in your `~/.npmrc`.

2. **Configure environment**

   ```bash
   cp .env.example .env.local
   ```

   Add credentials for your LLM provider (Anthropic API key, AWS credentials, or GCP project). See [Configuration](#configuration). For local-only usage with Ollama, no `.env.local` changes are needed. Configure it from the Settings UI instead.

3. **Set up a sandbox runtime** (pick one):

   **Option A: Docker** (default)

   ```bash
   docker build -t hermetic-sandbox docker/sandbox
   ```

   Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/).

   **Option B: Microsandbox** (lightweight microVMs)

   ```bash
   # Install the microsandbox server
   curl -sSL https://get.microsandbox.dev | sh

   # Start the server (dev mode, no API key required)
   msb server start --dev
   ```

   Then set in `.env.local`:

   ```
   SANDBOX_RUNTIME=microsandbox
   MICROSANDBOX_URL=http://127.0.0.1:5555
   ```

   Requires macOS Apple Silicon (M1+) or Linux with KVM.

   **Option C: E2B** (cloud sandbox)

   ```
   SANDBOX_RUNTIME=e2b
   E2B_API_KEY=your-e2b-key
   ```

   Sign up at [e2b.dev](https://e2b.dev).

4. **Start the dev server**

   ```bash
   pnpm dev
   ```

5. Open [http://localhost:3000](http://localhost:3000)

## Features

### For Non-Technical Users

- **Ask your data anything.** Type a question in plain English — no SQL, no code, no formulas.
- **Conversational follow-ups.** Hermetic keeps conversation context server-side. "Exclude outliers and re-run", "break that down by quarter", "compare to last year" all work without re-explaining the setup.
- **Suggested follow-ups.** After a fresh analysis, inline pills suggest the next obvious questions based on what just came back.
- **Smart question suggestions.** After loading data, the LLM analyzes your schema and suggests specific, insightful questions tailored to your actual columns and patterns.
- **Try with sample data.** One-click sample dataset to explore Hermetic without needing your own data.
- **Start in one drag.** Drag a file straight onto the home screen (or click to browse), and see real example dashboards — the kind Hermetic generates — before you upload anything. The start screen leads with the privacy guarantee: the model writes the analysis code, but never sees your rows.
- **Show your work.** Every analysis includes a plain-English methodology explanation — how many rows were analyzed, which columns were used, what operations were performed.
- **Grounded numbers.** Every figure in a dashboard's narrative is checked against what the analysis actually computed; any number that traces to no result is flagged with a "verify this" caveat instead of being presented as fact. Applies to both single-shot dashboards and Investigate.
- **Filters that recompute, not re-average.** A compiled dashboard's filter controls are derived, never written by a model: a series that declared a dimension gets a filter bar, and when the analysis also declares **how a measure aggregates** (e.g. a rate is `sum(churned)/sum(active)`, never the average of per-group rates), the chart is rebuilt from the source table on every change — including by dimensions its own aggregated rows never carried. The recipe is replayed against the declared rows before any control ships; if it doesn't reproduce them exactly, the chart stays static and the disagreement is logged. Each filter bar states what it governs.
- **Four output styles.** Choose how results are framed: Dashboard (at-a-glance grid), Brief (bottom-line-up-front), Report (formal sectioned document), or Deep dive (exhaustive multi-angle). Slides (PPTX / Reveal deck) is an export format. The style is stamped into each analysis' record, so a restored dashboard's style picker always shows what it was actually run with. In compiled mode the style also scales narrative depth and which charts ship (a deep dive narrates every claim with signal; a brief stays on the bottom line).
- **Edit the dashboard.** On compiled dashboards, an **Edit** toggle opens a panel: drag sections to reorder, hide or show any element, edit the synthesis paragraph, narrate a claim the story skipped, or add a chart from the derived catalog (each candidate view explains why it exists). Edits recompile instantly with no LLM call and persist with the analysis.
- **Light / Dark / System mode.** Toggle between light and dark themes, or follow your OS preference.

### Trust & Verification

- **Declared findings and checks.** The analysis declares what it found and which data-quality checks it ran — as typed claims with computed evidence, not prose. Failed checks surface as a banner and bindable caveats; a "blocking" check that fails gates the run's results as unvalidated instead of shipping them quietly.
- **Regime-aware statistics.** Sentinel zeros, thin trailing periods, heavy tails, mixed currencies, disordered axes — each declared series is profiled and the hazards are answered inside the statistics library itself (see [Philosophy](#philosophy)), with the applied policy disclosed in the output (`n_zero_excluded`, attestation bars, `weighted` fits, which test ran).
- **Verify panel.** Every analysis carries a machine-readable verifiability record — composer mode, findings declared vs. cited, failed checks, headline tiles planned vs. delivered, prose advisories, and a grounding report tracing each narrative figure to its computation. Exportable as JSON.
- **Non-blind audit.** One click runs an adversarial review over the derived artifacts (never raw rows): a second model tries to break the dashboard's story against its own numbers. The verdict persists as part of the analysis record and survives restore — it has caught real miscalibrations the lint battery shared blind spots with.
- **Lint battery + bounded repair.** Dozens of coherence lints cross-check narrative, results, charts, and claims — dangling citations, silently executed screens, orphaned methodological decisions, unit mismatches, contradictory verdicts, thin-data headlines. Severe narrative defects trigger one bounded recompose pass with explicit repair instructions; the rest surface as advisories.
- **Curated learning.** Successful runs can seed future ones as exemplars — but only through a quality gate (runs with severe lint findings are vetoed from teaching) and a `/learning` page where you review and curate what the engine keeps.

### Agentic Analysis

- **Investigate agent.** One question, a full deep-dive. The planner decomposes it into a few focused, penetrating sub-questions — the count scaled to the output style (a Brief stays tight at ~3; a Deep dive goes wide) — the orchestrator runs independent ones in parallel waves and dependent ones serially, and a composer synthesizes them into a single unified dashboard. Against a **data warehouse**, each sub-question generates its own targeted SQL that aggregates server-side over the full population (no row-cap sampling bias), bounded to a scan window sized from engine metadata so a billion-row table never blows the read limit. Progress streams live as a step list with status icons. The planner sees schema and stats only — never row values. Results render as a unified dashboard or as a step-by-step **notebook view** (each step's question, code, and result as a cell), exportable to Markdown, HTML, PDF, or Slides.
- **Per-run diagnostics.** Every Investigate (and Ask) run writes one structured JSON record to `data/diagnostics/<date>.jsonl` — materialization (rows, sampled, Parquet, SQL repairs), per sub-question (path, escalations + reason, retries + error classes, status), an aggregate summary, plus cost and call count. A `/diagnostics` page aggregates the records — runs per day, failure modes ranked by frequency, escalations, recent failures with run ids — so "why did this run cost or behave this way" is answerable from data, not guesswork.
- **Multi-retry with reflection.** When generated code fails, the pipeline retries up to three times, carrying the full history of failed attempts forward. A reflection prompt kicks in after two failures so the model sees what it tried and why it broke, not just the original prompt.
- **Scheduled runs.** Saved dashboards can be scheduled with node-cron. Schedule popover anchored to the dashboard toolbar, schedule pills on saved-viz cards with edit/delete in place — a dashboard you built last week refreshes itself every Monday morning.
- **Persistent history.** Every analysis auto-saves to disk (generated code, results, visualizations, the verifiability record, and any audit verdict — one record, no side-files). History survives restarts. Browse from a dedicated page, restore any previous result instantly, or re-run it against fresh data. Saved visualizations record the history entry they came from, so a restored viz keeps its audit and provenance.
- **URL-addressable views.** Browser back/forward walks the app's own transitions (results → data → home), and a results URL carries its reconstruction key — paste it in a new tab and the analysis restores.

### Skills — teach it your domain

- **Drop-in skills.** A skill is a folder — `data/skills/<name>/SKILL.md` — that teaches the engine a domain: activation triggers (column-name regexes, question keywords, data-source kind), prompt guidance, reviewer rules, and failure hints for the retry loop. Drop it in and it's live on the next question — no restart, no rebuild. Invalid files are skipped with a logged reason, and `GET /api/skills` lists every skill plus every rejected file with why.
- **Python helpers.** A sibling `helpers.py` ships into the sandbox as `skill_lib.<name>` when its skill activates. Function signatures and docstring first-lines are auto-advertised in the prompt — generated, not hand-written, so the prompt can never advertise a function the module doesn't define — and the model imports tested code instead of re-deriving formulas. `data/user_lib/*.py` modules preload on **every** run for team-wide metrics and loaders.
- **Built-in skills.** The engine's own geo expertise ships the same way: Overture polygon hydration, planet-scale superlatives (Parquet-footer coarse-to-fine scan + KD-tree), and map answer visibility are built-in skills activated per question — the critic, router, and guards stay domain-agnostic.
- **Pre-execution review gate.** An LLM critic lints generated code against the active skills' rules **before** it runs (won-only revenue, no OR'd bounding-box scans, significance before declaring an A/B winner, …) and forces a regeneration on findings — cheaper than paying for a doomed two-minute scan.
- **Worked samples.** Five sample skills ship in [`samples/skills/`](samples/skills/): sales correctness guards, cohort retention, A/B experiment readouts, anomaly windows, and spatial clustering (the Clark-Evans index via scipy as a preloaded helper). Full authoring guide: [`docs/creating-skills.md`](docs/creating-skills.md).

### Data Sources

- **File uploads.** CSV, Excel (multi-sheet workbooks with relationship detection), GeoJSON, JSON.
- **Parquet and DuckDB.** Local Parquet files and Hive-partitioned folders, with a file browser to pick them. Files bind-mount directly into the sandbox (zero-copy). For datasets over ~1M rows, aggregation is pushed into DuckDB SQL before touching pandas.
- **Data warehouses.** PostgreSQL, BigQuery, ClickHouse, Snowflake, Databricks, Trino, Hive. SQL generated automatically from natural language, with cross-table JOINs and dialect-aware prompt guidance.
- **dbt metadata enrichment.** If a dbt project is wired up, column-level descriptions are pulled into the LLM context alongside the warehouse schema.
- **Saved connections.** One-click reconnect to previously used warehouses — visible directly in the connection card. Per-warehouse tabs and color codes in the UI.
- **Data explorer.** Collapsible right-side rail showing schema (column names, types, samples), data profile (row counts, distributions), and sample rows. Supports Excel sheet tabs and warehouse table navigation with split-panel layout.

### Visualization

- **57 chart types.** Core (bar, line, area, pie, scatter, histogram, box, violin, heatmap); financial & KPI (candlestick, waterfall, funnel, gauge, bullet, dual-axis); flow & hierarchy (sankey, chord, treemap, sunburst, marimekko); statistics (Pareto, QQ, ECDF, survival/Kaplan–Meier, forest, control/SPC, correlogram, error bars/CI); ML (confusion matrix, ROC, calibration, lift/gain, partial dependence, SHAP beeswarm, dendrogram, silhouette, decision tree, network graph); and scientific/temporal (contour, ternary, population pyramid, Gantt, cohort grid, quiver, wind rose, calendar, stream, ridgeline, bump, radar, dumbbell, slope, beeswarm, sparkline, parallel coordinates).
- **3D visualizations.** Scatter3D, Surface3D, Globe3D, deck.gl maps.
- **Geographic maps.** MapLibre GL vector tile maps with GeoJSON overlays, deck.gl layers (hexagon, column, arc, scatterplot, heatmap) with click/hover interactivity.
- **Interactive pivot tables.** Sort, drill-through, drill-down, cross-filter against other widgets on the same dashboard, aggregator switcher, heatmap mode, multi-value and multi-aggregator support.
- **Adaptive dashboards.** The LLM composes layouts tailored to each question — bar charts for comparisons, line charts for trends, stat cards for KPIs.
- **Drill-down navigation.** Click chart segments to explore deeper.
- **Client-side filtering.** DataController enables instant cross-filtering across dashboards.
- **Expanded mode for every chart.** Chart components support full-height expanded rendering; labels truncate with tooltips instead of overlapping; WCAG-compliant font sizes throughout.

### Operations

- **Edit and re-run.** If the generated Python or SQL is 90% right, edit it directly in the code editor and rebuild the whole dashboard through the standard pipeline. The server skips the generation step for whichever artifact you edited and runs everything downstream.
- **Save and export.** Save visualizations; export as PDF, DOCX, PPTX — or as a **single-file interactive HTML** dashboard (see [Sharing dashboards](#sharing-dashboards)). Individual charts downloadable as PNG.
- **Artifacts viewer.** Bottom sheet panel with syntax-highlighted SQL, Python code, and computed data tables. Copy to clipboard or export as CSV/XLSX.
- **Update data.** Re-run saved visualizations with new data files. Schema-compatible updates skip LLM calls.
- **Cost tracking.** Every analysis' LLM token cost is captured automatically across the whole fan-out (code-gen, retries, planner, sub-questions, compose) with zero call-site threading, and surfaced three ways: a live footer (last analysis + running session total), a per-day CSV log (`data/cost/<date>.csv` with token buckets, per-analysis cost, and a **per-phase breakdown** — planner, SQL-gen, SQL-repair, code-gen, compose, …), and a `/cost` page with totals and a per-dataset breakdown, linked from Settings. Local or unknown models report $0 but still track tokens.
- **Cost-optimized by default.** Prompt caching (Anthropic ephemeral cache — roughly a 90% input discount on cache hits) wraps the large static prompts that every compose call re-sends, plus cheaper models for heavy vs. classification work, fewer retries, lazy cell composition, output volume scaled to the chosen style, and — for warehouse Investigate — per-step SQL that aggregates in the warehouse so code-gen runs over a small result instead of a million-row frame. The wins are largest on Investigate, which fans out into many LLM calls; per-phase cost telemetry is what made each lever measurable.
- **Resilient long runs.** Planet-scale analysis won't OOM-kill the sandbox: a memory watchdog polls the container 4×/second, an up-front feasibility gate refuses a plan that already can't fit, DuckDB is capped to the container's real limit (scan threads included), `.df()` pulls are hard-capped so an unguarded materialization can't take out the container, and the coarse-to-fine scan counts candidate cells instead of materializing them. A preflight lint catches forgotten imports before execution; when a run does die, the retry carries a **phase-accurate** signal — which progress phase was executing, plus any skill-provided remedy — instead of a generic OOM blob. The app holds a wake lock during execution so a sleeping laptop doesn't sever a long remote scan, an in-flight run survives a browser reload or dev hot-reload, and **Stop actually stops** — it kills the in-flight LLM call and the sandbox process, not just the spinner. Code-gen and retries stream into the progress panel live, and each attempt's diagnostics (config, phase, output tails) persist to the run directory.

### Configuration

- **Multiple LLM providers.** Anthropic, AWS Bedrock, Google Vertex AI, OpenAI-compatible endpoints, or the **Claude CLI** — use your own `claude` login (Pro/Max subscription or API billing) with no API key. The Claude 5 family (Sonnet 5, Opus 5, …) is selectable per task: separate model pickers for code generation and dashboard composition.
- **One golden source for settings.** Model choices, sandbox runtime, composer architecture, and effort levels live in `data/runtime-config.json` and are resolved server-side for **every** harness — web, MCP, and CLI always run the same configuration (the browser is a mirror, not a second store).
- **Per-phase reasoning effort.** Set one global effort level, or override it per pipeline phase (code-gen vs. compose vs. review vs. planning) from Settings — analytical phases can think hard while classification stays cheap.
- **Composer architecture.** Switch between the generative and compiled composers from Settings (see [Philosophy](#philosophy)); the compiled path is what enables deterministic recompiles and dashboard editing.
- **Local models.** MLX (Apple Silicon), llama.cpp, or Ollama. Detect, download, and activate models from the Settings drawer.
- **Four themes.** Focus (emerald, default), Stamen (cartographic), Info is Beautiful (vivid), Pentagram (reductive). Each with light and dark variants.
- **Sandbox runtimes.** Docker (local), E2B (cloud), Microsandbox (microVM).

## Using from Claude (MCP server)

Hermetic doubles as a [Model Context Protocol](https://modelcontextprotocol.io) server: any MCP host — Claude Desktop, Claude Code, or another MCP-speaking agent — gets hermetic's pipeline as tools while data, execution, and dashboards stay on your machine.

- **17 tools**: `analyze` (the full pipeline as one call, with `composer_sight` and output-style options), `analyze_start`/`analyze_status`/`analyze_result`/`analyze_cancel` (the same pipeline as a background job with long-poll progress — for hosts that cancel long tool calls), `connect_source`, `get_schema`, `run_sql`, `run_analysis` (host-authored Python in the sandbox), `verify_narrative`, `audit_analysis` (the on-demand non-blind audit as a tool), `get_dashboard_plan` / `edit_dashboard` (read a compiled dashboard's edit surface — sections, un-narrated claims, the derived view catalog — and edit it through the same governed mutation grammar as the web UI), `persist_dashboard`, `export_dashboard`, `list_sources`, plus `dashboard_data` (internal, app-only — feeds the inline MCP Apps viewer).
- **Embedded viewer**: dashboard links work with nothing else running (loopback-only server inside the MCP process), with the app's full theming and a download button.
- **Inline dashboards (MCP Apps)**: hosts that support the [MCP Apps extension](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) (Claude Desktop, VS Code, Goose) render `analyze`/`persist_dashboard` results as an interactive dashboard **inside the chat** — the spec travels as `structuredContent` to a sandboxed iframe (never into model context), and the viewer template is fully self-contained (no external requests). Text-only hosts see exactly the old JSON responses.
- **Trust model**: guards sit on authorship — host-written SQL passes a read-only gate before any connector sees it, host-written Python runs with networking denied, host-written specs validate against the catalog in enforcing mode. Every call lands in an audit log; the egress allowlist is proven in CI by an exfiltration canary.
- **Setup**: `./scripts/install-mcp.sh` (detects Claude Desktop/Code, asks, writes config, builds the viewer). Claude Code needs nothing inside this checkout — the repo's `.mcp.json` auto-prompts.

Full tool reference, trust model, and observability guide: [docs/mcp.md](docs/mcp.md).

## Sharing dashboards

Any analysis exports as **one self-contained `.html` file** — spec, data, renderer, charts, themes, and fonts inlined. It opens in any browser from `file://`, offline, with full interactivity (filters, cross-filter, drill-down), and needs no server, hosting, or account. Send it over Slack or email, or drop it on a shared drive.

- ~3 MB for typical dashboards (the exporter inlines only the chart families the spec uses; 3D/geo/finance dashboards are larger) — the size and bundle are reported at export time.
- Available from the web app's export menu ("Interactive HTML"), the CLI (`hermetic render <history-id> --html out.html`), and MCP (`export_dashboard`, plus an `export_url` on every `analyze` response).
- The exported file strips pipeline-internal state, carries an as-of watermark and the verbatim question, and contains only what the dashboard shows.

Design and rationale: [`specs/dashboard-distribution-2026-08-05.md`](specs/dashboard-distribution-2026-08-05.md).

## Data Warehouses

In addition to file uploads, Hermetic can connect directly to data warehouses. Ask questions in natural language and Hermetic generates SQL automatically, executes it against your warehouse, then analyzes and visualizes the results.

Supported warehouses: **PostgreSQL**, **BigQuery**, **ClickHouse**, **Snowflake**, **Databricks**, **Trino**, **Hive**.

### Connecting

On the home screen, the **Connect a warehouse** card shows your saved connections as one-click pills. Click one to connect instantly. To add a new connection, click the card and fill in the type-specific form (host, port, credentials). Hermetic introspects all tables (columns, types, primary keys, foreign keys) so the LLM can generate cross-table JOINs.

Credentials are saved automatically after a successful connection. Saved connections are managed from the Settings drawer.

### How it works

```
User asks question
    → LLM generates dialect-aware SQL (bounded to a metadata-sized scan window)
    → Server executes it — self-healing on engine errors (repair + retry)
    → Results flow as CSV into the existing pandas pipeline
    → Analysis code runs in sandbox → interactive dashboard
```

The SQL is available in the **Artifacts** panel (SQL tab) alongside the Python analysis code.

### Warehouse queries are hardened — and Investigate goes further

**Every** warehouse query — single-shot **Ask** and multi-step **Investigate** alike — runs through the same shared hardening, so a billion-row table doesn't sink it:

- **Bounded scan from engine metadata (not a data scan).** Before generating SQL, Hermetic sizes a recent window from metadata — ClickHouse `system.tables` sort-key bounds, BigQuery `INFORMATION_SCHEMA.PARTITIONS` (partition values + row counts), with a `MIN/MAX` fallback on a real date column — and hands that exact window to SQL-gen so the query never trips the read/byte limit.
- **Self-healing SQL.** A failed query is repaired by feeding the exact engine error back to the model — bad GROUP BY, memory blowup, a too-wide scan (`rows to read exceeded`), an empty result from a dead partition filter — and retried. Co-occurrence/pairwise questions are steered to array collapse + `ARRAY JOIN` instead of fact-table self-joins.

**Investigate adds more for its fan-out:**

- **Bounded materialization + per-step SQL.** It materializes one bounded snapshot for planning, then each sub-question generates its **own** targeted query that aggregates server-side over the full population (no row-cap sampling bias), returning a small result — code-gen runs over kilobytes instead of a million-row frame.
- **Large pulls via Parquet + DuckDB.** A big materialized pull is converted to Parquet and analyzed through DuckDB before pandas — raising the in-memory ceiling well past a million rows, fallback-safe to CSV. When the snapshot is a capped sample, the dashboard discloses it.

Tested end-to-end against live public warehouses (ClickHouse Playground, BigQuery public datasets).

### PostgreSQL

Works with PostgreSQL, Amazon Redshift, Neon, Supabase, AlloyDB, CockroachDB, and any PostgreSQL wire-compatible database.

**Connection fields:**

| Field    | Example     | Notes                     |
| -------- | ----------- | ------------------------- |
| Host     | `localhost` | Hostname or IP            |
| Port     | `5432`      | Default: 5432             |
| Database | `mydb`      |                           |
| User     | `postgres`  |                           |
| Password |             |                           |
| Schema   | `public`    | Default: public           |
| SSL      | unchecked   | Check for cloud databases |

**Environment variables** (optional, for `start.sh` or `.env.local`):

```bash
WAREHOUSE_TYPE=postgresql
WAREHOUSE_PG_HOST=localhost
WAREHOUSE_PG_PORT=5432
WAREHOUSE_PG_DATABASE=mydb
WAREHOUSE_PG_USER=postgres
WAREHOUSE_PG_PASSWORD=secret
WAREHOUSE_PG_SCHEMA=public
WAREHOUSE_PG_SSL=false
```

**Sample dataset — Pagila (DVD rental):**

```bash
# Start a local PostgreSQL with the Pagila sample database
docker run -d --name pagila \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgresai/extended-postgres:16

# Load the Pagila dataset
docker exec -i pagila psql -U postgres -c "CREATE DATABASE pagila;"
curl -sL https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-schema.sql | docker exec -i pagila psql -U postgres -d pagila
curl -sL https://raw.githubusercontent.com/devrimgunduz/pagila/master/pagila-data.sql | docker exec -i pagila psql -U postgres -d pagila
```

Then connect with: host `localhost`, port `5432`, database `pagila`, user `postgres`, password `postgres`.

Try asking: _"What are the top 10 most rented films and their total revenue?"_

### ClickHouse

**Connection fields:**

| Field    | Example               | Notes                      |
| -------- | --------------------- | -------------------------- |
| Host     | `play.clickhouse.com` | Hostname or IP             |
| Port     | `443`                 | 8123 (HTTP) or 443 (HTTPS) |
| Database | `default`             |                            |
| User     | `play`                |                            |
| Password |                       | Leave empty for playground |
| SSL      | checked               | Required for port 443      |

**Environment variables** (optional):

```bash
WAREHOUSE_TYPE=clickhouse
WAREHOUSE_CH_HOST=play.clickhouse.com
WAREHOUSE_CH_PORT=443
WAREHOUSE_CH_DATABASE=default
WAREHOUSE_CH_USER=play
WAREHOUSE_CH_PASSWORD=
WAREHOUSE_CH_SSL=true
```

**Free sample dataset — ClickHouse Playground:**

No setup needed. Connect to `play.clickhouse.com` (port `443`, user `play`, no password, SSL on). This public playground has dozens of pre-loaded datasets:

| Table                            | Description              | Rows   |
| -------------------------------- | ------------------------ | ------ |
| `uk_price_paid`                  | UK property transactions | 28M+   |
| `trips`                          | NYC taxi trips           | 3B+    |
| `cell_towers`                    | OpenCellID cell towers   | 43M+   |
| `dns`                            | DNS query logs           | 1M+    |
| `github_events`                  | GitHub event stream      | 200M+  |
| `stock`                          | Daily stock prices       | varies |
| `menu`, `menu_page`, `menu_item` | NYC restaurant menus     | varies |
| `opensky`                        | Flight tracking data     | 60M+   |

Try asking: _"Show the average property price trend by year in London"_ (against `uk_price_paid`)

### BigQuery

**Connection fields:**

| Field                | Example                              | Notes                                     |
| -------------------- | ------------------------------------ | ----------------------------------------- |
| Project ID           | `my-gcp-project`                     | Your GCP project (for billing)            |
| Dataset              | `bigquery-public-data.stackoverflow` | Use `project.dataset` for public datasets |
| Service Account JSON | `{ "type": "service_account", ... }` | Paste JSON key or path to `.json` file    |

**Environment variables** (optional):

```bash
WAREHOUSE_TYPE=bigquery
WAREHOUSE_BQ_PROJECT=my-gcp-project
WAREHOUSE_BQ_DATASET=bigquery-public-data.stackoverflow
WAREHOUSE_BQ_CREDENTIALS_JSON=/path/to/service-account.json
```

**Setup (5 minutes):**

1. Create a GCP project at [console.cloud.google.com](https://console.cloud.google.com) (free tier, no credit card for public datasets)
2. Go to **IAM & Admin > Service Accounts** > Create service account
3. Grant roles: **BigQuery Job User** + **BigQuery Data Viewer**
4. **Keys** > Add Key > Create new key > JSON — download the file
5. In Hermetic, enter your project ID, dataset, and paste the JSON key

**Free public datasets** (no data to load — already available):

| Dataset                                        | Description            |
| ---------------------------------------------- | ---------------------- |
| `bigquery-public-data.stackoverflow`           | Stack Overflow posts   |
| `bigquery-public-data.github_repos`            | GitHub repository data |
| `bigquery-public-data.austin_crime`            | Austin crime reports   |
| `bigquery-public-data.chicago_taxi_trips`      | Chicago taxi data      |
| `bigquery-public-data.usa_names`               | US baby names by year  |
| `bigquery-public-data.new_york_subway`         | NYC subway ridership   |
| `bigquery-public-data.google_analytics_sample` | GA web analytics       |

Enter the dataset as `bigquery-public-data.stackoverflow` (the `project.dataset` format tells Hermetic to query from that project while billing your project).

Try asking: _"What are the most popular programming language tags by year?"_

### Snowflake

**Connection fields:**

| Field     | Example             | Notes                             |
| --------- | ------------------- | --------------------------------- |
| Account   | `xy12345.us-east-1` | Your Snowflake account identifier |
| Username  | `analyst`           |                                   |
| Password  |                     | Or use key-pair auth              |
| Warehouse | `COMPUTE_WH`        |                                   |
| Database  | `ANALYTICS`         |                                   |
| Schema    | `PUBLIC`            |                                   |
| Role      | `ANALYST_ROLE`      | Optional                          |

### Databricks

**Connection fields:**

| Field           | Example                            | Notes                                     |
| --------------- | ---------------------------------- | ----------------------------------------- |
| Server hostname | `abc-1234.cloud.databricks.com`    | Your workspace host                       |
| HTTP path       | `/sql/1.0/warehouses/abc123def456` | From the SQL warehouse connection details |
| Access token    | `dapi…`                            | Personal access token                     |
| Catalog         | `main`                             |                                           |
| Schema          | `default`                          |                                           |

### Trino / Hive

Both have inline connection forms with host, port, catalog/database, and credentials. Trino works with Starburst and any Trino-compatible engine.

## Parquet and Local Files

Point Hermetic at a Parquet file or a Hive-partitioned folder on your local disk and analyze it without uploading.

Click the **Browse local files** entry on the home screen, navigate to the file or folder, and pick it. The file is bind-mounted into the sandbox (zero-copy — no upload, no conversion). DuckDB extracts schema and statistics; for queries over ~1M rows, aggregation is pushed into DuckDB SQL before any pandas code runs.

Hive-partitioned folders (e.g. `year=2024/month=01/...`) are detected as a single dataset; partition columns appear in the schema alongside the file columns.

## Command line

The CLI drives the same pipeline with no web server:

```bash
pnpm cli ask "What is the MRR trend over time?" data.csv --out spec.ndjson
pnpm cli render <history-id> --html dashboard.html   # single-file export
```

`ask` streams the analysis as NDJSON patches and persists it to history; `render` exports a persisted entry as a self-contained interactive HTML file. Reference: [docs/cli.md](docs/cli.md).

## Architecture

```
src/
  app/                  Next.js harness (App Router)
    api/                ~60 thin route handlers delegating to lib
      query/            Ask + Investigate streaming endpoints (NDJSON patches)
      upload/, local-files/, remote-parquet/   File & Parquet ingestion (shared lib/sources/ingest)
      warehouse/        Connection, introspection (cached + FK inference), sample
      vizs/, history/   Saved visualization CRUD + scheduling; persistent history
      export-html/, export/[id]/   Single-file interactive HTML export
      skills/, diagnostics/, cost/, health/, providers/, runtimes/, local-llm/
    components/         Application UI (top bar, settings, data rail, panels, home)
    lib/                Browser-side app plumbing (typed API client, client-log bridge)
    diagnostics/, cost/, history/   Operational pages
  components/           The renderer library (future @hermetic/renderer — CI-checked closure)
    charts/             57 chart components (Nivo, Plotly, deck.gl, MapLibre GL)
    controllers/        DataController for client-side filtering
    inputs/             Form inputs
    theme/              Theme system (4 themes × light/dark; shared with viewer + export)
    registry.tsx, spec-view.tsx, data-table.tsx, pivot-table.tsx
  spec/                 Vendored spec system fork (future @hermetic/spec — bottom of the stack)
  lib/                  Framework-free core (no Next, no React — lint-enforced)
    contracts/          Owned shared types (stream protocol, requests, schemas, configs)
    csv/, excel/, geojson/, parquet/, local-files/   Parsers & schema extraction
    sources/            Shared ingestion seam (upload, local-files, MCP all consume it)
    warehouse/          Connectors (postgres, bigquery, clickhouse, snowflake, databricks,
                        trino, hive), read-only SQL guard, engine descriptors, cached
                        introspection + FK inference, dbt metadata
    sqlgen/             Dialect-aware SQL generation + self-healing repair
    llm/                LLM client & transports (incl. Claude CLI), prompts, planners/composers
    findings/           Declared-findings grammar: validation, coherence lints (the battery),
                        manifest projection, headline planning
    product/            Analysis Product: declared series/values with roles, the Binding
                        Catalog, component role signatures, roles index
    compose/            The compiled composer: plan/document DSL + validator and
                        per-node salvage, planner call, deterministic realizer, view
                        catalog, derived filter controllers with baseline replay
                        verification, scaffold, mutation grammar, edit surface
                        (specs/narrative-compiler-2026-08-09.md)
    learning/           Exemplar bank + quality veto (user-curated at /learning)
    skills/             Skill system: triggers, guidance, review rules, helpers (docs/creating-skills.md)
    pipeline/           Orchestration: Ask/Investigate runners, retry loops, review gate,
                        patch streaming, run control, grounding verification, audit, caches
    sandbox/            Execution: Docker / E2B / Microsandbox, capability descriptors,
                        egress allowlist (CI-proven exfiltration canary), lifecycle
    export/             Single-file HTML export assembler
    history/, saved/, cost/, diagnostics/   Persistence, scheduling, cost capture, run records
  cli/                  CLI harness (ask, render) — the architecture canary, runs in CI
  mcp/                  MCP server harness: 17 tools, audit log, error taxonomy,
    viewer/             embedded dashboard viewer + export bundles (esbuild, no Next)
  harness/              Boot seam shared by non-Next harnesses (env config snapshot)
docker/sandbox/
  hermetic_runtime/     The tested Python statistical runtime shipped into every sandbox run:
                        declare_finding/declare_check/declare_series, the claim library
                        (finding_trend, finding_superlative, finding_current_state, …),
                        regime profiling + the closed regime matrix (regimes.py), guards,
                        output envelope — pure-python exact p-values, ~100 unit tests
specs/                  Design records with principal-engineer/data-scientist reviews —
                        declared findings, analysis product, regime matrix (the generated
                        matrix table is drift-pinned by tests), narrative compiler
```

### How It Works

**File uploads:**

1. **Load.** CSV, Excel (multi-sheet), GeoJSON, JSON, or Parquet file is parsed, schema extracted, and stored in memory (Parquet stays on disk and is bind-mounted into the sandbox).
2. **Query.** User question + schema (and prior conversation history, if any) sent to your configured LLM for Python code generation, along with guidance from any skills whose triggers match the schema or question.
3. **Execute.** Generated code runs in a sandboxed Python environment with pandas, numpy, scipy, scikit-learn, and DuckDB, plus the **hermetic runtime** — the tested statistical package the code declares its findings, checks, and series through (regime profiling and the claim library live here) — and any active skills' helper modules under `skill_lib`. When a review gate is active, an LLM critic lints the code against the skills' rules first and regenerates on findings. Failures retry up to 3× with a reflection prompt after the second attempt.
4. **Validate.** The declared-findings manifest is validated and the lint battery cross-checks claims, results, chart data, and regime profiles; severe defects (a failed blocking check, an unapplied declared policy) gate or retry before anything composes.
5. **Compose.** The generative composer streams a render spec from result schemas and the findings manifest — or the compiled composer writes the document in one small call (prose whose every figure is a binding) and compiles layout, charts, and filter controls deterministically. Either way the same finalizer resolves bindings, renders declared units, and runs the discourse checks; a verifiability record is stamped into the spec.
6. **Render.** The spec is streamed to the browser and rendered as interactive React components. Every analysis auto-saves to persistent history (record + verifiability + any audit verdict), and compiled dashboards stay editable in place.

**Warehouse queries** add two steps before the standard pipeline:

1. **SQL Generation.** User question + all table schemas (columns, types, PKs, FKs, dbt descriptions if present) sent to the LLM to generate a dialect-aware SQL query — under a contract that pins the traps SQL runs kept falling into (word-boundary name filters with a matched-names audit, exact quantiles, single-currency restriction with the exclusion declared, rollups that actually aggregate).
2. **SQL Execution.** Query runs against the warehouse. Failures are repaired with the engine's error annotated at the exact failing position in the SQL. Results flow as CSV into the standard pipeline (steps 2–6 above).

**Investigate** runs a higher-level loop on top of the standard pipeline:

1. **Plan.** The planner sees schema + stats only and decomposes the question into 3–7 sub-questions with a dependency graph.
2. **Orchestrate.** Independent sub-questions run in parallel waves; dependent ones run serially. Each sub-question uses the standard pipeline.
3. **Compose.** The composer synthesizes all sub-results into a single unified render spec.

**Conversational follow-ups** are handled by the conversation cache: each turn's question, generated code, and result schema are kept server-side so the next turn's LLM call has full context. "Exclude outliers and re-run" works without you restating the original setup.

**Edit-and-rerun.** Open the code editor, change the Python or SQL, and re-run. The server skips the corresponding generation step and runs everything downstream.

**Saved visualizations** can be updated with new data files (schema-compatible updates skip LLM calls) or scheduled to refresh on a cron (node-cron). Schedule pills appear on saved-viz cards with edit/delete in place.

## Development

```bash
pnpm dev             # Start dev server
pnpm build           # Production build
pnpm lint            # ESLint
pnpm lint:fix        # ESLint with auto-fix
pnpm format          # Prettier format
pnpm format:check    # Prettier check
pnpm type-check      # TypeScript check
pnpm test            # Run tests (vitest, ~2,400 tests)
pnpm test:watch      # Tests in watch mode
python3 -m unittest docker.sandbox.hermetic_runtime.test_runtime   # Sandbox statistical runtime tests
pnpm cli ask ...     # CLI harness (no web server)
pnpm mcp             # MCP server over stdio
pnpm mcp:build-viewer  # Build the embedded viewer + export bundles
node scripts/ratchet.mjs         # Design-flaw counters (fail CI on regression)
node scripts/isolation-check.mjs # Package-closure proof (spec / contracts / renderer)
pnpm analyze         # Bundle analysis
```

## Sandbox Runtimes

Hermetic executes LLM-generated Python code in an isolated sandbox. Three runtimes are supported:

| Runtime              | How it works                          | Requirements                                                                                               |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Docker** (default) | Runs code in a local Docker container | [Docker Desktop](https://www.docker.com/products/docker-desktop/)                                          |
| **Microsandbox**     | Runs code in a lightweight microVM    | macOS Apple Silicon or Linux with KVM; [microsandbox server](https://github.com/microsandbox/microsandbox) |
| **E2B**              | Runs code in a cloud sandbox          | [E2B](https://e2b.dev) account and API key                                                                 |

Set `SANDBOX_RUNTIME` in `.env.local` to switch runtimes. The startup script (`start.sh`) lets you choose interactively.

## Configuration

### LLM Provider

**Where configuration lives** (2026-08): product settings (provider endpoints, sandbox tuning, retention) live in `data/runtime-config.json` — shared by the web app, the MCP server, and the CLI — with environment variables as the seed/fallback. **Secrets never persist in hermetic-written files**: API keys added via Settings and warehouse connection credentials are stored in your **OS keychain** (macOS Keychain / Linux Secret Service / Windows Credential Manager); environment variables remain the headless/CI path. Existing `warehouse-connections` files migrate their credentials into the keychain automatically on first load.

Pick **one** provider. If `LLM_PROVIDER` is not set, the app auto-detects from available credentials. Ollama can be enabled from the Settings UI without any environment variables, and the **Claude CLI** needs no key at all — it uses your existing `claude` login (see below).

| Variable                 | Required                      | Default     | Description                                                                                        |
| ------------------------ | ----------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `LLM_PROVIDER`           | No                            | auto-detect | Force a provider: `anthropic`, `claude-cli`, `bedrock`, `vertex`, `openai-compatible`, or `ollama` |
| `ANTHROPIC_API_KEY`      | If provider=anthropic         |             | Anthropic API key                                                                                  |
| `AWS_ACCESS_KEY_ID`      | If provider=bedrock           |             | AWS access key (or use `AWS_PROFILE`)                                                              |
| `AWS_SECRET_ACCESS_KEY`  | If provider=bedrock           |             | AWS secret key                                                                                     |
| `AWS_REGION`             | No                            | `us-east-1` | AWS region for Bedrock                                                                             |
| `GOOGLE_VERTEX_PROJECT`  | If provider=vertex            |             | GCP project ID                                                                                     |
| `GOOGLE_VERTEX_LOCATION` | No                            | `us-east5`  | GCP region for Vertex AI                                                                           |
| `OPENAI_BASE_URL`        | If provider=openai-compatible |             | OpenAI-compatible endpoint URL                                                                     |
| `OPENAI_API_KEY`         | No                            |             | API key for the endpoint (not needed for Ollama)                                                   |
| `OPENAI_MODEL`           | If provider=openai-compatible |             | Model name (e.g. `llama3.3`, `gpt-4o`)                                                             |

### Claude CLI (use your own Claude login, no API key)

If you have the Claude CLI (Claude Code) installed and authenticated — `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in — Hermetic can use it as a provider with **no API key**. Set `LLM_PROVIDER=claude-cli`, pick it in **Settings > Inference**, or just have `claude` on your `PATH` and it's auto-detected as a last-resort fallback (a configured API key still wins).

Each analysis call shells out to `claude -p` with the model chosen per task (the same internal model IDs as the Anthropic provider), authenticating with whatever credentials the CLI itself holds — a Pro/Max subscription or API billing. When the CLI provider is selected, API-key variables are stripped from its environment, so calls always use the CLI's own login instead of silently billing a leftover `ANTHROPIC_API_KEY`. Built-in tools are disabled on every call (Hermetic runs its generated code in its own sandbox and never uses the CLI's tools), which keeps per-call overhead minimal. If `claude` isn't on `PATH`, set `claudeCli.binaryPath` in `data/runtime-config.json`.

Cost is reported at **equivalent API rates** (the CLI can be metered per token, so `$0` would mislead), with cache reads priced at the cheap cache-read rate. It's an estimate, not the CLI's own bill.

**Thinking effort** is routed by pipeline phase: the analytical phases (code generation, SQL generation/repair, the skill code-review gate) run at `high`, while composition, planning, and classification run at `low` — at the CLI's own default effort, roughly two-thirds of a compose call's billed output tokens were invisible reasoning (measured: ~$0.20 and 3+ minutes extra per dashboard). Force a single level for everything with `HERMETIC_CLAUDE_CLI_EFFORT=low|medium|high|xhigh|max`, or `default` to defer to the CLI's own setting. Older CLIs without `--effort` are detected and run unchanged.

> Note: for a self-hosted app where each user authenticates their own `claude`, this is the intended use. Anthropic's terms do not permit _offering_ claude.ai login or subscription rate limits as a feature of a third-party product.

### Local Models (MLX / llama.cpp / Ollama)

No environment variables needed. Open **Settings > Inference > Local Models** to detect, download, and activate models directly from the UI. MLX is available on Apple Silicon Macs. All three backends are managed from the same settings panel.

1. Install Ollama: `brew install ollama` (macOS) or see [ollama.com](https://ollama.com)
2. Start the server: `ollama serve`
3. Open Settings in Hermetic and activate a model

Recommended models for data analysis:

| Model                   | RAM    | Notes                             |
| ----------------------- | ------ | --------------------------------- |
| `qwen2.5-coder:14b`     | 16 GB+ | Best balance of quality and speed |
| `qwen2.5-coder:7b`      | 8 GB+  | Good for smaller machines         |
| `qwen2.5-coder:32b`     | 32 GB+ | Highest quality                   |
| `deepseek-coder-v2:16b` | 16 GB+ | Strong code and analysis          |
| `llama3.3:latest`       | 16 GB+ | General purpose                   |

When Ollama is activated in Settings, it takes priority over cloud providers. Deactivate it from Settings to switch back.

### Sandbox Runtime

| Variable               | Required                | Default                 | Description                                                      |
| ---------------------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| `SANDBOX_RUNTIME`      | No                      | `docker`                | Sandbox runtime: `docker`, `e2b`, or `microsandbox`              |
| `E2B_API_KEY`          | If runtime=e2b          |                         | E2B API key                                                      |
| `MICROSANDBOX_URL`     | If runtime=microsandbox | `http://127.0.0.1:5555` | Microsandbox server URL                                          |
| `MICROSANDBOX_API_KEY` | No                      |                         | Microsandbox API key                                             |
| `MICROSANDBOX_IMAGE`   | No                      | `microsandbox/python`   | Docker Hub image for the sandbox (packages installed at startup) |

## Components

### Charts

| Component           | Purpose                                | Library    |
| ------------------- | -------------------------------------- | ---------- |
| BarChart            | Categorical comparisons                | Nivo       |
| LineChart           | Trends over time                       | Nivo       |
| AreaChart           | Trends with volume                     | Nivo       |
| PieChart            | Part-of-whole composition              | Nivo       |
| ScatterChart        | Correlation between variables          | Nivo       |
| RadarChart          | Multivariate comparison                | Nivo       |
| BumpChart           | Ranking changes over time              | Nivo       |
| ChordChart          | Flow between categories                | Nivo       |
| SunburstChart       | Hierarchical composition               | Nivo       |
| TreemapChart        | Hierarchical proportions               | Nivo       |
| SankeyChart         | Flow quantities between nodes          | Nivo       |
| MarimekkoChart      | Two-dimensional composition            | Nivo       |
| CalendarChart       | Values over calendar days              | Nivo       |
| StreamChart         | Stacked trends over time               | Nivo       |
| Histogram           | Value distribution                     | Plotly     |
| BoxPlot             | Statistical distribution               | Plotly     |
| HeatMap             | Matrix of values by color              | Plotly     |
| ViolinChart         | Distribution shape comparison          | Plotly     |
| CandlestickChart    | OHLC financial data                    | Plotly     |
| WaterfallChart      | Cumulative value changes               | Plotly     |
| RidgelineChart      | Overlapping distributions              | Plotly     |
| DumbbellChart       | Range between two values               | Plotly     |
| SlopeChart          | Change between two points              | Plotly     |
| BeeswarmChart       | Distribution with individual points    | Plotly     |
| ShapBeeswarm        | SHAP feature importance                | Plotly     |
| ConfusionMatrix     | Classification performance             | Plotly     |
| RocCurve            | Binary classifier performance          | Plotly     |
| ParallelCoordinates | Multivariate patterns                  | Custom SVG |
| BulletChart         | Progress toward a target               | Custom SVG |
| DecisionTree        | Tree model visualization               | Custom SVG |
| ErrorBarChart       | Points/bars with confidence intervals  | Plotly     |
| DualAxisChart       | Two measures on independent y-axes     | Plotly     |
| FunnelChart         | Sequential conversion / drop-off       | Plotly     |
| GaugeChart          | Single KPI against a scale             | Plotly     |
| Sparkline           | Compact inline trend                   | Custom SVG |
| ParetoChart         | 80/20 — sorted bars + cumulative %     | Plotly     |
| QQPlot              | Normality check vs. quantiles          | Plotly     |
| ECDFChart           | Empirical cumulative distribution      | Plotly     |
| SurvivalChart       | Kaplan–Meier survival curves           | Plotly     |
| ForestPlot          | Effect sizes with confidence intervals | Plotly     |
| ControlChart        | SPC chart with control limits          | Plotly     |
| Correlogram         | ACF / PACF autocorrelation             | Plotly     |
| CalibrationCurve    | Classifier reliability diagram         | Plotly     |
| LiftChart           | Lift / cumulative gain                 | Plotly     |
| PartialDependence   | Model PDP / ICE curves                 | Plotly     |
| Dendrogram          | Hierarchical clustering tree           | Plotly     |
| SilhouettePlot      | Clustering quality by cluster          | Plotly     |
| NetworkGraph        | Node-link relationships                | Plotly     |
| ContourChart        | 2D density / scalar field              | Plotly     |
| TernaryChart        | Three-part compositional data          | Plotly     |
| PopulationPyramid   | Back-to-back category comparison       | Plotly     |
| GanttChart          | Task timelines on a date axis          | Plotly     |
| CohortGrid          | Retention matrix by cohort × period    | Plotly     |
| QuiverChart         | Vector / flow field                    | Plotly     |
| WindRose            | Polar histogram by direction           | Plotly     |

### 3D and Geospatial

| Component | Purpose                                       | Library        |
| --------- | --------------------------------------------- | -------------- |
| Scatter3D | 3D point clouds                               | Plotly         |
| Surface3D | 3D surface plots                              | Plotly         |
| Globe3D   | Points and arcs on a 3D globe                 | react-globe.gl |
| Map3D     | Hexagon, column, arc, scatter, heatmap layers | deck.gl        |
| MapView   | Markers and GeoJSON polygons on a 2D map      | MapLibre GL    |

### Display

| Component      | Purpose                               | Library        |
| -------------- | ------------------------------------- | -------------- |
| StatCard       | Single KPI with trend                 | Custom         |
| TextBlock      | Markdown or plain text                | Custom         |
| SectionBreak   | Visual section divider                | Custom         |
| Annotation     | Contextual notes                      | Custom         |
| TrendIndicator | Directional change indicator          | Custom         |
| DataTable      | Sortable, filterable, paginated table | TanStack Table |
| PivotTable     | Sort, drill, cross-filter, heatmap    | Custom         |
| ChartImage     | Rendered image from sandbox           | Custom         |
| DataController | Client-side cross-filtering           | Custom         |

### Inputs

| Component     | Purpose                        | Library |
| ------------- | ------------------------------ | ------- |
| SelectControl | Dropdown select                | Custom  |
| NumberInput   | Numeric input with constraints | Custom  |
| ToggleSwitch  | Boolean toggle                 | Custom  |
| TextInput     | Single-line text input         | Custom  |
| TextArea      | Multi-line text input          | Custom  |

## Tech Stack

**Framework and rendering**

- [Next.js 16](https://nextjs.org/) with React 19
- An owned, vendored fork of [JSON-Render](https://json-render.dev/) (`src/spec`, with its own test suite) for streaming declarative UI from JSON specs
- [Tailwind CSS v4](https://tailwindcss.com/)

**LLM integration**

- [Vercel AI SDK](https://sdk.vercel.ai/) with providers for Anthropic, AWS Bedrock, Google Vertex, and OpenAI-compatible endpoints, plus a custom transport that shells out to the Claude CLI and to local MLX / llama.cpp / Ollama backends
- [Zod](https://zod.dev/) for schema validation

**Charting**

- [Nivo](https://nivo.rocks/) (14 chart types)
- [Plotly.js](https://plotly.com/javascript/) (15 chart types including 3D)
- [deck.gl](https://deck.gl/) for large-scale geospatial layers
- [react-globe.gl](https://github.com/vasturiano/react-globe.gl) for 3D globe rendering
- [MapLibre GL JS](https://maplibre.org/) via [react-map-gl](https://visgl.github.io/react-map-gl/) for 2D vector tile maps
- [Three.js](https://threejs.org/) (peer dependency for globe and deck.gl)

**Data tables**

- [TanStack Table](https://tanstack.com/table) for headless table logic

**Data parsing**

- [PapaParse](https://www.papaparse.com/) for CSV
- [ExcelJS](https://github.com/exceljs/exceljs) for Excel workbooks
- [DuckDB](https://duckdb.org/) for Parquet, Hive-partitioned folders, and pushdown aggregation (in the sandbox)

**Warehouse drivers**

- [`pg`](https://node-postgres.com/) for PostgreSQL / Redshift / Neon / Supabase / AlloyDB
- [`@google-cloud/bigquery`](https://cloud.google.com/bigquery) for BigQuery
- [`@clickhouse/client`](https://clickhouse.com/) for ClickHouse
- [`snowflake-sdk`](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver) for Snowflake
- [`@databricks/sql`](https://docs.databricks.com/en/dev-tools/nodejs-sql-driver.html) for Databricks
- [`trino-client`](https://github.com/regadas/trino-js-client) for Trino / Starburst
- [`hive-driver`](https://github.com/lenchv/hive-driver) for Apache Hive

**Export**

- [jsPDF](https://github.com/parallax/jsPDF) for PDF generation
- [docx](https://github.com/dolanmiu/docx) for Word documents
- [PptxGenJS](https://github.com/gitbrent/PptxGenJS) for PowerPoint presentations
- [html-to-image](https://github.com/bubkoo/html-to-image) for chart PNG snapshots

**Sandbox runtimes**

- [Docker](https://www.docker.com/) for local container execution
- [E2B](https://e2b.dev/) for cloud sandbox execution
- [Microsandbox](https://github.com/microsandbox/microsandbox) for microVM execution

**Development**

- TypeScript 5, ESLint 9, Prettier, Husky, lint-staged
- [Vitest](https://vitest.dev/) with Testing Library for unit tests
- [@next/bundle-analyzer](https://www.npmjs.com/package/@next/bundle-analyzer) for bundle analysis

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines.

## License

[MIT](LICENSE)

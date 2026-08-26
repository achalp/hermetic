# Landscape refresh — July 2026

_Last updated: 2026-07-31. Successor to the 2026-06-20 comparison set
(`hermetic-vs-{hex,julius-vizly,powerbi,thoughtspot}-2026-06-20.md`); adds the
warehouse-native NL-SQL tier (Cortex Analyst / Genie / BigQuery Gemini) and
ChatGPT's July agent launch, then re-derives where Hermetic's differentiation
actually sits._

---

## What changed in the landscape since June

**Everyone is "agentic" now.** The word has stopped discriminating.

- **Hex** — Notebook Agent (Claude-powered) is the product's center of
  gravity: prompt → SQL/Python → chart in the notebook, agentic cell creation,
  scheduled runs; Team plan $24/user/mo, 1,000+ data teams claimed.
- **Julius AI** — evolved from chat-with-data into a platform: Notebooks for
  repeatable workflows, database connectors, team collaboration, R + Python,
  shareable interactive links. Still the reference "friendly AI analyst" for
  non-technical users.
- **ChatGPT Work** (launched July 9, 2026, on GPT-5.6) — agent mode that takes
  a brief, works for minutes-to-hours, and ships finished deliverables:
  spreadsheets, decks, reports, web apps. Advanced Data Analysis remains the
  file-upload path. This is the largest-audience competitor by far.
- **Warehouse-native NL-SQL is GA everywhere** — Snowflake Cortex Analyst
  (YAML semantic models, API-first, now wired into Cortex Agents via MCP),
  Databricks AI/BI Genie (Unity Catalog metadata, chat product), BigQuery
  Gemini. Accuracy stands or falls on curated semantic models/metadata.
- **Power BI Copilot** — widest install base; 2026 brought full conversational
  reports on mobile, 10K-char prompts, Copilot-assisted semantic modeling; Q&A
  retired in favor of Copilot by Dec 2026.
- **ThoughtSpot** — Spotter plus a team of agents (SpotterViz dashboards,
  SpotterModel semantic models, SpotterCode embedded analytics) reaching GA
  through early 2026.

## What still distinguishes Hermetic (and what stopped distinguishing it)

**No longer differentiating on its own:** multi-step agentic analysis,
NL→SQL against a warehouse, notebooks, scheduled runs, chart breadth,
conversational follow-ups. Every column of the June matrices that said
"agentic loop" is now table stakes.

**Still nobody else's architecture:**

1. **The model never sees the rows.** Every competitor above sends data to
   the model or runs the model inside the vendor's cloud over your data.
   Hermetic's model sees schema + computed results only; code executes in a
   local sandbox. This remains architecturally unique in the set, not a
   feature toggle.
2. **Bring-your-own model, local-first, open source.** Local models (MLX /
   llama.cpp / Ollama), any API, or a Claude subscription via the CLI — no
   per-seat SaaS. No competitor offers a serious local-model path.
3. **Raw open data at planet scale without a warehouse.** Querying a 2.5B-row
   public Parquet dataset in place (footer-metadata pruning → sparse tail →
   exact answer) has no analog in the set; the warehouse-native tools require
   the data to already live in their engine, ChatGPT/Julius require upload.
4. **Teachability with enforcement.** Closest analogs are Cortex Analyst's
   YAML semantic models and Genie's metadata curation — both describe the
   _data_. Hermetic skills encode the _analysis_: domain recipes (prompt
   guidance), reviewer rules enforced by a pre-execution critic, failure
   hints for the retry loop, and tested Python helpers the generated code
   imports instead of re-deriving. Knowledge + enforcement + code, per
   question, live-reloaded from a folder.
5. **Verifiability as a product surface.** Grounded narratives, per-step
   audit trail, honest scope disclosure (`analysis_scope`), and a reviewer
   that rejects wrong-but-valid queries (sampled aggregates, dropped
   constraints) before execution. Competitors verify accuracy with semantic
   layers; Hermetic verifies the _artifact_.

**Where the set is genuinely ahead of Hermetic:** team collaboration and
sharing (all of them), semantic-model governance (Snowflake/ThoughtSpot),
mobile (Power BI), distribution/audience (ChatGPT). These remain deliberate
non-goals per the Tier-3 stance in `specs/archive/competitive-feature-gaps-2026-04-25.md` —
except sharing, where the static-export path (Parquet snapshot + DuckDB-WASM
bundle, spec'd 2026-06-17) is the local-first answer and still open.

## Implication for positioning

The June story ("Hermetic is agentic too") is dead — everyone is. The July
story writes itself from the diff: **an analyst that is private by
construction, works on data wherever it lives (including nowhere), can be
taught your domain and held to it by a reviewer, and shows its work.** Those
five properties are compounding, not independent: teachability is safe
_because_ execution is sandboxed; planet-scale is honest _because_ of scope
disclosure; all of it is auditable _because_ the model only ever writes code.

## Sources

- [Hex — Introducing the Notebook Agent](https://hex.tech/blog/introducing-notebook-agent/) · [Notebook Agent updates](https://hex.tech/blog/notebook-agent-updates/) · [Hex AI capability page](https://hex.tech/capability/ai/)
- [Julius AI review 2026 (SimilarLabs)](https://similarlabs.com/blog/julius-ai-review) · [Julius AI guide (Social Think)](https://socialthink.io/blog/julius-ai/)
- [ChatGPT Work — agent mode overview (FelloAI)](https://felloai.com/chatgpt-work/) · [ChatGPT ADA practical guide (Obot)](https://obot.ai/resources/learning-center/chatgpt-advanced-data-analysis/)
- [Cortex Analyst vs Genie vs BigQuery Gemini (Agami)](https://blog.agami.ai/snowflake-cortex-analyst-vs-databricks-genie-vs-bigquery-gemini-warehouse-native-ai-compared/) · [Cortex Analyst docs](https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-analyst) · [Colrows — where warehouse-native AI stops](https://colrows.com/blogs/cortex-analyst-vs-genie/)
- [Power BI June 2026 feature summary](https://community.fabric.microsoft.com/t5/Power-BI-Updates-Blog/Power-BI-June-2026-Feature-Summary/ba-p/5193264) · [Power BI 2026 updates (AlphaBOLD)](https://www.alphabold.com/power-bi-2026-updates/)
- [ThoughtSpot Spotter agents (TechTarget)](https://www.techtarget.com/searchbusinessanalytics/news/366636078/ThoughtSpot-automates-full-platform-with-new-Spotter-agents)

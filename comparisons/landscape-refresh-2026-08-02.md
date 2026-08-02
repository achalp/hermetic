# Landscape refresh — August 2026

_Last updated: 2026-08-02. Successor to
[landscape-refresh-2026-07-31.md](./landscape-refresh-2026-07-31.md); adds the
**open-source tier** the July refresh didn't cover — surveyed while evaluating
Vanna ([hermetic-vs-vanna-2026-08-01](./hermetic-vs-vanna-2026-08-01.md)) and
Wren AI ([hermetic-vs-wrenai-2026-08-02](./hermetic-vs-wrenai-2026-08-02.md))
for the comparison set — and re-derives the differentiation claims against it.
The July analysis of the commercial tier (Hex, Julius, ChatGPT Work,
warehouse-native NL-SQL, Power BI, ThoughtSpot) carries forward unchanged._

---

## What's new: the open-source tier, mapped

The July refresh treated the landscape as commercial SaaS + warehouse-native.
There is a third tier — open-source chat-with-your-data — and it matters
because it occupies Hermetic's own quadrant: open source, BYO/local LLM,
self-hosted, metadata-only context. Surveyed 2026-08-01 (activity verified via
GitHub API):

**Alive:**

- **Wren AI** (Canner, Apache 2.0, ~16.8k stars, pushed this week) — the real
  competitor. Governed "GenBI": MDL semantic layer (Git-versioned YAML with
  metrics + row/column ACLs), Rust engine on DataFusion that mechanically
  validates generated SQL pre-execution, 20+ warehouses with federation, any
  LiteLLM provider including Ollama, concurrent-session pricing (from $99/mo,
  no seats). 2026 pivot to agent-first: CLI, LangChain/Pydantic AI SDKs,
  Claude Code/Cursor integrations, WASM browser-side dashboards.
- **DB-GPT** (~19.6k stars, active) — multi-agent Text2SQL framework with
  fine-tuning and a workflow language; strongest in fine-tuned-model accuracy,
  developer-facing.
- **Chat2DB** (~27.6k stars, active) — AI-augmented SQL client GUI; a desktop
  tool for people who write SQL, not an analytics product.
- **DataLine** (~1.6k stars, low activity) — privacy-first local
  chat-with-data app; the only other entrant with Hermetic's local-first,
  sensitive-data ethos, but a fraction of the surface area.

**Dead or frozen — the attrition pattern:**

- **Vanna** (~24k stars) — repo archived 2026-03-29, months after the 2.0
  rewrite; commercial gravity moved to hosted Vanna Cloud; community forks
  patching the frozen codebase.
- **Dataherald** (~3.6k stars) — last push July 2024; company wound down.
- **defog/sqlcoder** (~4k stars) — last push May 2024; Defog went closed
  commercial.
- **PandasAI** (~23.7k stars) — nine months quiet (Oct 2025), company pushing
  its hosted platform; trending toward the same arc Vanna completed.

**The pattern is the finding.** Star-rich open-source text-to-SQL projects
keep converging on the same endpoint: freeze the OSS, sell the cloud. The
open-and-maintained-and-local combination Hermetic ships is the exact thing
this tier keeps failing to sustain.

## The structural threat worth naming: MCP

Generic database connectors (DBHub, Postgres MCP servers, warehouse MCP
endpoints — Cortex Agents already ship one) let any general agent — Claude
Code, Cursor, ChatGPT — chat with a database without a dedicated text-to-SQL
product. This is arguably what deflated the tier above: raw NL→SQL is now a
commodity a coding agent gets for free. Wren AI's answer is to become the
governed layer those agents call. Hermetic's answer is everything above SQL
generation: blind sandboxed execution, multi-step Investigate, 57-chart
composition, skills enforcement, verification. "We generate SQL from English"
is no longer a moat for anyone; the July refresh said this about "agentic,"
and it now applies one layer down.

## Differentiation claims, re-derived against the new tier

Numbering follows the July refresh.

1. **The model never sees the rows — holds, with a nearest-neighbor now
   identified.** Wren AI's metadata-first posture (LLM sees the MDL, engine
   executes, dashboards render browser-side via WASM) is the closest
   architecture in the landscape, and Vanna v1 made a similar claim before
   2.0's dual-output design eroded it. The distinction that survives: those
   systems stay inside SQL's expressive bounds to keep the model blind.
   Hermetic runs arbitrary Python statistics under the same blindness —
   sandboxed, network-disabled, results flowing to the composer as schemas
   and placeholders. Nobody else combines full computational depth with a
   row-blind model.
2. **Bring-your-own model, local-first, open source — no longer unique;
   restate it.** The July claim "no competitor offers a serious local-model
   path" is now false: Wren AI (LiteLLM + Ollama), DB-GPT (fine-tuned local
   models), and Vanna forks all do. What remains true: Hermetic's local story
   is the most complete (curated MLX / llama.cpp / Ollama tiers, Claude CLI
   subscription path, per-analysis cost tracking) and — per the attrition
   pattern — the most likely to still be maintained next year. The claim
   should be stated as durability + completeness, not exclusivity.
3. **Raw open data at planet scale without a warehouse — holds, unchallenged.**
   The entire open-source tier is database-first; files enter, if at all,
   through a DuckDB side door. Nobody touches the 2.5B-row-Parquet-in-place
   story.
4. **Teachability with enforcement — holds; the closest analog changed.**
   July cited Cortex Analyst's YAML models. The closer analog is now Wren's
   context layer (MDL + version-controlled `instructions.md` + reusable
   skills + LanceDB memory) — Git-native and genuinely converging on this
   axis — with Vanna's RAG training the best-known schema-teaching
   implementation. Both still describe the _data_ and _definitions_. Neither
   enforces _analysis method_ (Wren's dry-plan validation catches schema/ACL
   violations, not wrong-but-valid methodology) and neither ships executable
   helper code. Skills' enforcement + tested-code combination remains unique,
   but this is now the most actively contested axis: watch Wren.
5. **Verifiability as a product surface — holds, unchallenged.** Grounded
   narratives, per-step audit trail, scope disclosure, pre-execution critic.
   Wren's mechanical SQL validation is real but orthogonal (it governs query
   validity, not artifact truthfulness); nothing in either tier checks the
   numbers in the output against what was actually computed.

**Where the open-source tier is ahead of Hermetic:** multi-user governance and
sharing (Wren: ACLs, audit logs, shareable WASM dashboards, embeddable GenBI
apps), warehouse breadth and federation (Wren: Oracle, SQL Server, Athena,
Spark), agent/IDE embeddability (Wren SDKs, Vanna's `<vanna-chat>`). Same
Tier-3 stance as July: deliberate non-goals, except sharing, where the
static-export path (spec'd 2026-06-17) remains the open answer — Wren's
browser-side WASM dashboards are prior art worth studying for it.

## Implication for positioning

July's story — private by construction, works anywhere, teachable with
enforcement, shows its work — survives contact with the open-source tier, but
two claims need sharpening. **Exclusivity → durability** on local/BYO-model:
Hermetic isn't the only local-first option, it's the one whose open-source
promise has no cloud pivot waiting (no per-seat product to protect — the
attrition pattern is the evidence). And **the moat is above SQL**: with NL→SQL
commoditized by MCP and governed by Wren, Hermetic's defensible layer is the
analysis itself — blind Python execution, Investigate, enforcement,
verification — which no SQL-bounded system can follow without abandoning the
constraint that keeps it safe. Sharpest one-line contrast in the set: **Wren
governs definitions; Hermetic verifies analysis.** They're complementary
enough that "run both" is plausible — which is exactly why Wren, not any SaaS
incumbent, is now the competitor to watch.

## Sources

- [hermetic-vs-vanna-2026-08-01](./hermetic-vs-vanna-2026-08-01.md) · [hermetic-vs-wrenai-2026-08-02](./hermetic-vs-wrenai-2026-08-02.md) (full per-competitor sourcing)
- [Vanna repo (archived 2026-03-29)](https://github.com/vanna-ai/vanna) · [WrenAI repo](https://github.com/Canner/WrenAI) · [DB-GPT repo](https://github.com/eosphoros-ai/DB-GPT) · [Chat2DB repo](https://github.com/OtterMind/Chat2DB) · [DataLine repo](https://github.com/RamiAwar/dataline) · [Dataherald repo](https://github.com/Dataherald/dataherald) · [sqlcoder repo](https://github.com/defog-ai/sqlcoder) · [PandasAI repo](https://github.com/sinaptik-ai/pandas-ai) — stars/archived/last-push verified via GitHub API 2026-08-01
- [Wren AI pricing](https://www.getwren.ai/pricing) · [Wren AI versus hub](https://www.getwren.ai/versus) · [Dissecting open-source NL2SQL (Vanna / WrenAI / DB-GPT)](https://sudiptapathak.com/blog/dissecting-open-source-nl2sql/)
- [Bytebase — top text-to-SQL tools 2026 (incl. DBHub/MCP)](https://www.bytebase.com/blog/top-text-to-sql-query-tools/) · [Towards AI — forking archived Vanna](https://pub.towardsai.net/i-turned-an-archived-23k-star-text-to-sql-project-into-a-self-hosted-tool-that-actually-works-out-b08abcb6d0e3)

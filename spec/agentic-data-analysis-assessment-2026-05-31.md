# Agentic Data Analysis — SOTA Assessment & Hermetic Gap Analysis

_Last updated: 2026-06-04_

> **Status update (2026-06-04):** All four Tier 1 items have shipped. Hermetic now rates **level 4** on the capability ladder below. The body of this document is preserved as the pre-Tier-1 assessment; see [Appendix A — What shipped](#appendix-a--what-shipped-2026-06-04) for the post-implementation rating and what remains.

**Companion document:** [`agentic-tier-1-implementation-plan-2026-05-31.md`](./agentic-tier-1-implementation-plan-2026-05-31.md) — concrete implementation plan for the four Tier 1 items called out at the end of this doc.

**Related prior docs:**

- [`competitive-feature-gaps-2026-04-25.md`](./competitive-feature-gaps-2026-04-25.md) — competitive gaps from the April comparison set (the original Tier 1 list, all now shipped).
- [`tier-1-implementation-plan-2026-04-25.md`](./tier-1-implementation-plan-2026-04-25.md) — the April Tier 1 plan (Snowflake/Databricks, pivot tables, scheduled runs, edit-rerun, dbt metadata, follow-ups, widgets).
- [`comparisons/hermetic-vs-hex-2026-05-31.md`](../comparisons/hermetic-vs-hex-2026-05-31.md) — the May feature-level comparison against Hex.

---

## Scope

This document does three things:

1. Surveys the state of the art in **agentic data analysis** as of May 2026, drawing on the research literature (DSBench, MLE-bench, Data Interpreter, AIDE, AutoMind, DeepAnalyze) and the leading products (Hex Notebook Agent, Julius AI, ChatGPT Code Interpreter / Deep Research).
2. Assesses **where Hermetic sits** on the resulting capability ladder, based on a code-level read of `investigate-planner.ts`, `investigate-orchestrator.ts`, and `investigate-composer.ts`.
3. Specifies the **minimum set of changes** required for Hermetic to be classifiable as a true agentic data analysis tool by the working definition the field has converged on.

It is a strategy doc, not an implementation plan. The implementation plan for Tier 1 is the companion document above.

---

## 1. State of the art

### 1.1 Working definition

The field has converged on a working definition of "agentic" data analysis as a system that **plans → acts (via tools) → observes → reflects → re-plans** in a loop, with autonomy over the trajectory of the analysis. The defining characteristic is the loop, not any single component. A planner without a re-planning step is a smart batch executor, not an agent.

### 1.2 What benchmarks tell us

Even frontier models behind purpose-built scaffolding plateau well below human-expert performance on end-to-end data work:

| Benchmark             | Year      | Best published result                                                          |
| --------------------- | --------- | ------------------------------------------------------------------------------ |
| **DSBench**           | Sept 2024 | Best agent solves **34.12%** of 466 analysis tasks; 34.74% relative perf gap.  |
| **MLE-bench**         | Oct 2024  | `o1-preview` + **AIDE scaffold** earns bronze in **16.9%** of 75 Kaggle comps. |
| **DSAEval**           | 2026      | Wide real-world tasks; consistent gap to expert humans.                        |
| **DataSciBench**      | Feb 2025  | LLM-agent benchmark for data science; comparable gap.                          |
| **InfiAgent-DABench** | Jan 2024  | Data-analysis-task agent eval; trajectories matter more than base model.       |

Two consistent signals across all of them:

- **Scaffolding matters more than the base model.** The same `o1-preview` with a worse scaffold drops below 5% on MLE-bench.
- **Open-ended autonomy is the hardest part.** Closed-form tasks (write code to compute X) are tractable; open-ended exploration ("figure out what's interesting") is where the gap is widest.

### 1.3 SOTA research scaffolds

In rough order of capability:

1. **Data Interpreter** (Feb 2024) — ReAct-style loop: plan → write code → execute → observe → revise. Hierarchical task graph, dynamic re-planning, code verification.
2. **AIDE** (2024) — Treats ML engineering as **tree search over solution attempts**. Each node is a code attempt; the agent explores, evaluates, and prunes. This is the scaffold that earned bronze on MLE-bench when wrapped around `o1-preview`.
3. **AutoMind** (June 2025) — Adds an **adaptive knowledge base** of techniques the agent has seen before, plus a curriculum that ramps task difficulty.
4. **DeepAnalyze-8B** (Oct 2025) — Claimed "first end-to-end agentic LLM" for autonomous data science research. Open-ended: agent decides what to investigate, generates its own sub-goals, writes a research report. Not just answering a question — driving the inquiry.

### 1.4 SOTA products

- **Hex Notebook Agent** (GA Aug 2025; Claude Sonnet 4-backed): writes and edits cells, **understands upstream/downstream cell dependencies**, debugs its own work, can author chart + pivot + Python + SQL + markdown cells. Operates inside the notebook as a pair programmer.
- **Julius AI**: warehouse-connected, plain-English multi-step analyses, chart generation, conversational refinement. Closer to the single-shot pattern but with iterative follow-up.
- **ChatGPT Code Interpreter + Deep Research**: interpret-execute-reflect loop with file I/O. Deep Research adds web tool use and longer-horizon planning.
- **Anthropic Computer Use, Sweet Spot, Numerous, Quadratic AI**: variations on the same pattern — code-gen agent inside a spreadsheet, notebook, or browser with tool access.

### 1.5 The capability ladder

Distilled from both research and products, the spectrum of agentic capability looks like this:

| Level | Capability                                                                                                            | Example                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0     | Single-shot code-gen, no error recovery                                                                               | LLM + REPL, circa 2023                     |
| 1     | + Multi-retry on errors with the original prompt                                                                      | Most "AI for data" tools, 2024             |
| 2     | + **Planning**: decompose into sub-tasks before executing                                                             | Data Interpreter v1, Hermetic Investigate  |
| 3     | + **Parallel / DAG execution** with dependency awareness                                                              | Hex (cell graph)                           |
| 4     | + **Reflection loop**: observe results, identify gaps, **re-plan**                                                    | Data Interpreter, AIDE                     |
| 5     | + **Multi-tool use** beyond code-gen: search, file system, doc lookup, external APIs                                  | Hex Notebook Agent, ChatGPT DR             |
| 6     | + **Semantic self-debugging**: notices empty DataFrames, suspicious nulls, wrong-looking numbers, retries differently | AIDE, frontier ML-eng agents               |
| 7     | + **Hypothesis-driven**: generates hypotheses, designs analyses to falsify them                                       | DeepAnalyze, frontier research             |
| 8     | + **Open-ended autonomy**: agent picks its own goal ("tell me what's interesting in this data")                       | DeepAnalyze, autonomous research scaffolds |
| 9     | + **Cross-task memory and self-improvement**: learns from prior runs, builds a knowledge base                         | AutoMind, frontier curriculum agents       |

---

## 2. Where Hermetic actually sits

Based on a code-level read of the Investigate stack, Hermetic is at **level 2.5** — solid planner + parallel executor + composer with a per-step reflection on code-gen errors, but no investigation-level loop. _(This was the rating as of 2026-05-31. Tier 1 has since shipped, moving Hermetic to level 4 — see [Appendix A](#appendix-a--what-shipped-2026-06-04).)_

### 2.1 What's working

- ✅ **Planning** (`investigate-planner.ts`): decomposes into 3–7 sub-questions with rationales and a `depends_on: number | null` field. Schema-only, no row data.
- ✅ **Parallel execution** (`investigate-orchestrator.ts`): groups sub-questions into waves and runs each wave with `Promise.all`. Linear dependency chains supported.
- ✅ **Per-step retry with reflection**: the underlying single-shot pipeline (`orchestrator.ts`) does up to 3 retries on code-gen failure and injects a reflection prompt after attempt 2.
- ✅ **Result composition** (`investigate-composer.ts`): a separate composer synthesizes sub-results into a unified JSON-Render spec. Failed sub-questions surface as `Annotation` components, not silently dropped.
- ✅ **Schema-only privacy**: planner and composer never see row values.
- ✅ **Server-side conversation cache** for follow-ups.
- ✅ **Persistent history** + restore.

### 2.2 The gaps vs SOTA — priority order

#### Gap 1 — No re-planning loop _(highest leverage)_

The plan is fixed at the moment `generatePlan()` returns. After wave 0 finishes, nothing in the orchestrator looks at the results and asks "should the plan change?" The composer only synthesizes; it doesn't dispatch new sub-questions.

Every SOTA agent has this loop. Without it, Hermetic is a parallelized batch executor with a smart plan up front, not an agent.

#### Gap 2 — Linear dependencies only

`depends_on: number | null` (a single integer index) cannot express:

- "Now compare the top region from step 1 with the bottom region from step 2."
- "Drill into the segment that shows the anomaly from any of steps 1, 2, or 3."

Real investigations have DAGs. The orchestrator's wave grouping in `investigate-orchestrator.ts` could already support multi-predecessor dependencies with a small change to the wave-readiness check.

#### Gap 3 — No semantic self-debugging

Retries fire on **exceptions**, not on **bad results**. If sub-question 2 returns an empty DataFrame, NaN-only columns, or a chart with one bar, the pipeline reports success. A SOTA agent (AIDE, Data Interpreter) inspects result quality and retries with a different approach.

#### Gap 4 — No tool use beyond code-gen

Hermetic generates Python and SQL and executes them. It cannot:

- Search the web for context.
- Read a dbt project file to look up a definition (dbt enrichment is one-shot at warehouse-connection time, not on-demand).
- Query the warehouse `INFORMATION_SCHEMA` on demand (separate from the user-data SQL path).
- Call any domain-specific API.

The agent has exactly one verb.

#### Gap 5 — Composer is one-shot

`composeInvestigation()` takes all sub-results and produces a spec in a single LLM call. It can't say "I need one more data point to write the conclusion" and dispatch a new sub-question. SOTA composers / writers can.

#### Gap 6 — No cross-investigation memory

Run three Investigates on the same dataset over a week and the planner starts from scratch each time. Past findings, columns that turned out to be useful, dead ends — none of it is retained. AutoMind-style knowledge bases solve this.

#### Gap 7 — No hypothesis layer

The planner's decomposition templates ("investigate-an-anomaly", "compare-two-things") are analysis patterns, not hypotheses. The agent doesn't say "I hypothesize the spike is driven by enterprise customers" and design an analysis to falsify it.

#### Gap 8 — No open-ended mode

Every Investigate needs a starting question. "Tell me what's interesting in this data" doesn't work because there's no goal-generation step.

#### Gap 9 — Follow-ups bypass Investigate

The conversation cache routes follow-ups through the single-shot pipeline, not back through Investigate. Drilling into "what's driving the APAC spike from step 3" runs single-shot — there's no sub-investigation construct.

#### Gap 10 — Investigation-level failure handling is binary

If a sub-question fails after retries, it's recorded as failed and the composer is told. The agent can't say "this approach didn't work, let me try a different one" at the investigation level. Half-or-more failures throws.

---

## 3. What it would take to be classifiable as agentic

Set the bar at **level 5** on the ladder above — planning + DAG execution + reflection loop + multi-tool use + semantic self-debugging. That's where Hex Notebook Agent and Data Interpreter sit, and it's the threshold the research community uses when calling something agentic.

### 3.1 Three tiers of work

#### Tier 1 — The minimum viable agentic loop (gets to level 4)

Closes Gaps 1, 2, 3, 5. These are the changes that flip the system from "smart batch executor" to "agent".

1. **Re-planning after each wave.** Between waves, send the planner the wave's result summaries and let it (a) keep the plan, (b) add 1–3 new sub-questions, or (c) abandon downstream sub-questions that are no longer informative. Cap total sub-questions per investigation to avoid runaway.
2. **DAG dependencies.** Change `depends_on: number | null` → `depends_on: number[]`. Update the wave grouping to require **all** predecessors complete. Update the conversation-context aggregator in `turnFromResult` to merge multiple priors.
3. **Semantic result validation.** Before marking a sub-question successful, run a cheap check on `executionResult`: empty results, NaN-only columns, single-row outputs, chart_data with zero rows. Treat these as soft failures that trigger an extra retry with a "your last result looked degenerate, here's why" reflection prompt.
4. **Composer-dispatched follow-ups.** Add a "gap" mode to the composer where it can return either a final spec OR a list of 1–2 follow-up sub-questions it needs. Loop until composer is satisfied or a hop limit hits.

Tier 1 is achievable without architectural changes — the planner, orchestrator, composer, and retry infrastructure are all in place. They need to be **wired into a loop** instead of a **pipeline**.

After Tier 1, Hermetic can be honestly described as agentic.

#### Tier 2 — Multi-tool use (gets to level 5)

Closes Gap 4. The larger investment because every new tool needs its own prompt patterns, evals, and (where applicable) sandbox isolation. But it's also what gives Hermetic the unique angle: **a privacy-preserving multi-tool agent**, where every tool except the LLM call runs on the user's machine.

Tool registry, minimum useful set:

- `searchWeb(query)` — for macro context the LLM doesn't know (with a clear privacy boundary: the agent must justify why a search is needed, and the user can disable web search globally for sensitive sessions).
- `readDbtModel(name)` — for definitions and lineage, on demand rather than only at connection time.
- `queryWarehouseMetadata(query)` — for ad-hoc `INFORMATION_SCHEMA` lookups (separate from the user-data SQL path).
- `searchPriorAnalyses(query)` — for cross-investigation memory once Tier 3 lands.

Also requires:

- **Tool-use prompting in the planner.** Today sub-questions implicitly assume code execution. Open this up: a sub-question can be answered by "search the web for the macro context on Q1 2026 retail", not just by a pandas operation.

#### Tier 3 — What separates good from frontier (level 6+)

Closes Gaps 6, 7, 8, 9. These are research-grade features and should be sequenced after Tiers 1 and 2 land.

- **Cross-investigation memory.** Persist `(dataset_fingerprint, useful_columns, dead_ends, validated_findings)` per dataset. Inject into planner context on the next run.
- **Hypothesis mode.** New planner output type: explicit hypotheses with falsification analyses. Composer reports which were supported / refuted / inconclusive.
- **Open-ended exploration.** "Find something interesting" mode. Requires a goal-generation step that proposes 3–5 candidate questions from schema + stats and lets the user pick or auto-runs all.
- **Drill-as-sub-investigation.** When the user asks a follow-up question on an Investigate result, route it through a scoped Investigate with prior context, not through single-shot.

### 3.2 The honest threshold

To be classifiable as a true agentic data analysis tool, Hermetic needs **Tier 1, minimum**. Specifically: the re-planning loop + DAG execution + semantic result validation. Everything else is upside.

The companion document [`agentic-tier-1-implementation-plan-2026-05-31.md`](./agentic-tier-1-implementation-plan-2026-05-31.md) specifies the four Tier 1 items in implementable detail.

---

## 4. Sources

- [DSBench: How Far Are Data Science Agents from Becoming Data Science Experts?](https://arxiv.org/pdf/2409.07703)
- [MLE-bench: Evaluating Machine Learning Agents on Machine Learning Engineering](https://arxiv.org/pdf/2410.07095)
- [Data Interpreter: An LLM Agent For Data Science](https://arxiv.org/pdf/2402.18679)
- [AutoMind: Adaptive Knowledgeable Agent for Automated Data Science](https://arxiv.org/pdf/2506.10974)
- [DeepAnalyze: Agentic Large Language Models for Autonomous Data Science](https://arxiv.org/pdf/2510.16872)
- [DataSciBench: An LLM Agent Benchmark for Data Science](https://arxiv.org/pdf/2502.13897)
- [InfiAgent-DABench: Evaluating Agents on Data Analysis Tasks](https://arxiv.org/pdf/2401.05507)
- [Introducing the Notebook Agent (Hex)](https://hex.tech/blog/introducing-notebook-agent/)
- [The Notebook Agent just got even better (Hex)](https://hex.tech/blog/notebook-agent-updates/)
- [Agentic AI Analytics Built for Data Teams (Hex)](https://hex.tech/capability/ai/)
- [Julius AI Guide (DataCamp)](https://www.datacamp.com/tutorial/julius-ai-guide)
- [Best Agentic AI Models January 2026 (WhatLLM.org)](https://whatllm.org/blog/best-agentic-models-january-2026)

---

## Appendix A — What shipped (2026-06-04)

All four Tier 1 items from the companion [`agentic-tier-1-implementation-plan-2026-05-31.md`](./agentic-tier-1-implementation-plan-2026-05-31.md) have landed. This appendix records the post-implementation state and supersedes the level-2.5 rating in §2.

### Capability-ladder rating: **level 4**

Investigate is no longer a parallelized batch executor. It now **plans → acts → observes → reflects → re-plans** in a bounded loop, with semantic self-debugging on degenerate results. By the working definition in §1.1, Hermetic is honestly classifiable as a true agentic data analysis tool. The four items map to the ladder as follows:

- **Level 3 (DAG execution)** — item #1.
- **Level 4 (reflection loop)** — items #3 and #4.
- **Level 6 trait (semantic self-debugging)** — item #2 lands the self-debugging behavior early, ahead of the broader level-5/6 work, but the headline rating stays at level 4 until multi-tool use (Tier 2) closes Gap 4.

### What shipped, item by item

| #   | Item                                      | Closes | Commit    | Key code                                                                                                                                |
| --- | ----------------------------------------- | ------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | DAG dependencies (`depends_on: number[]`) | Gap 2  | `61ba168` | `investigate-planner.ts` (array type, `normalizeDependsOn` back-compat, multi-dep prompt + few-shot); orchestrator wave-readiness check |
| 2   | Semantic result validation                | Gap 3  | `61ba168` | `pipeline/result-validator.ts`; retry-loop integration + `degraded` flag                                                                |
| 3   | Re-planning loop between waves (keystone) | Gap 1  | `cd6a5f0` | `generateReplan()` + `RE_PLANNER` prompt; orchestrator `while`-loop; `replan_decision` progress event                                   |
| 4   | Composer-dispatched follow-ups            | Gap 5  | `5ed3d49` | `gapCheckComposer()`; orchestrator gap-check → dispatch → compose, bounded by `COMPOSER_MAX_DISPATCHES`                                 |

Bounds are hard-coded in `src/lib/constants.ts`: `INVESTIGATE_MAX_HOPS = 2`, `INVESTIGATE_MAX_SUBQUESTIONS = 10`, `COMPOSER_MAX_DISPATCHES = 1`. A worst-case investigation runs at most 6 waves.

### Verification status

- ✅ **Unit tests pass** — 75 tests across `investigate-orchestrator.test.ts` (36, incl. re-planner integration, hop/sub-question caps, dangling-pending sweep, unsatisfiable-dep guards), `result-validator.test.ts` (15), `investigate-planner.test.ts`, and `investigate-composer.test.ts` (9; gap-check parser + dispatch-budget enforcement).
- ✅ **Per-item test plans** authored under `spec/testing/agentic-tier-1-*.md` for all four items.
- ✅ **Schema-only privacy preserved** — planner, re-planner, and composer (both modes) operate on result summaries and chart-data shapes, never row values.
- ⏳ **50-run synthetic eval — still outstanding.** The plan's out-of-band criterion (degenerate-result rate down vs. baseline; ≥10% of runs classified "amended" and ≥10% "stopped early"; zero runaway investigations) has not yet been run. Until it is, the level-4 rating rests on code review and unit tests, not on aggregate behavioral telemetry. **This is the gate before declaring Tier 1 fully complete.**

### What's next

Gap 4 (no tool use beyond code-gen) is the only remaining gap below level 5. The next capability tier is **Tier 2 — multi-tool use** (§3.1): a privacy-preserving tool registry (`searchWeb`, `readDbtModel`, `queryWarehouseMetadata`) plus tool-use prompting in the planner. Tier 3 (cross-investigation memory, hypothesis mode, open-ended exploration, drill-as-sub-investigation) follows once Tier 2 lands and there is telemetry on real investigations.

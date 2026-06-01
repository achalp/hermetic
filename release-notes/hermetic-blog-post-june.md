# Hermetic: closing the agentic loop

**TL;DR**: Hermetic's Investigate now runs as an actual agentic loop, not a parallelized batch executor. Between each wave of sub-questions, a re-planner inspects the results and can amend the plan or stop early. Sub-questions can depend on multiple priors (DAGs, not just chains). The pipeline retries on degenerate-but-successful results (empty DataFrames, all-zero charts) instead of only on exceptions. And the composer gets one chance before producing the final dashboard to ask for any missing data point it needs. Open source, local-first. [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

---

In the [last update](https://www.linkedin.com/pulse/hermetic-from-query-box-agentic-analysis-achal-prabhakar) I called Investigate "the closest Hermetic has gotten to feeling like an analyst rather than a query box." That was honest at the time. But after a few weeks of using it on real questions, the honest revision is sharper: it was a smart batch executor with a planner up front, not an agent. The plan was fixed at t=0. Whatever the sub-questions found, the plan didn't change in response. That's not how an analyst works.

This update closes that loop.

---

## What "agentic" actually means

The research community has converged on a working definition of an agentic data analysis system: it **plans → acts → observes → reflects → re-plans** in a loop, with autonomy over the trajectory. The defining characteristic is the loop, not any single component. A planner without a re-planning step is a smart batch executor, not an agent.

By that definition, the previous Investigate was at about level 2.5 on a ten-level capability ladder I wrote up while planning this work. Now it's at level 4. Frontier research agents are at level 7-9. The gap to level 5 is multi-tool use beyond code-gen (web search, dbt-on-demand lookups, warehouse metadata) — that's the next milestone, not what shipped in this batch.

Four specific changes got us to 4.

---

## Sub-questions can depend on multiple priors

The first thing that was missing was just expressiveness. The planner could express "step 2 depends on step 1" (linear chain) but not "step 3 depends on both step 1 and step 2." That meant a lot of natural decompositions couldn't be planned cleanly. "First identify the top region. Independently identify the bottom region. Then compare their growth trajectories" — that's a join, not a chain.

Now `depends_on` is `number[]` instead of `number | null`. The orchestrator's wave grouping handles DAGs: a sub-question lands in the earliest wave where every listed predecessor has finished. Diamonds work. Multi-predecessor joins work. Each completed predecessor's result schema flows into the dependent's prior-turn context so the LLM has the right information when it generates the code.

Back-compat is full — old plans with scalar `depends_on` values parse the same way.

---

## The pipeline retries when the result looks wrong, not just when it crashes

The retry loop used to fire only on exceptions. If the generated code ran cleanly but the filter was wrong and returned an empty DataFrame, that's still "success" as far as the pipeline was concerned. The empty result would surface to the composer, which would dutifully render a chart with no bars and a stat card reading `NaN`.

There's now a pure validator that runs on every successful execution. It detects: nothing computed at all, empty chart_data arrays, NaN/null scalars in the result, all-zero numeric columns across multi-row charts. When the validator flags a result, the pipeline retries — same retry budget as for exceptions — with a reflection prompt that includes both the bad code and the validator's reason. If the retry budget exhausts on a degenerate result, the pipeline returns it with `degraded: true` instead of throwing. The composer renders a warning annotation rather than failing the whole investigation.

The validator is deliberately conservative. A single null value mixed with valid numerics doesn't count (legitimate missing-data gap). A single-row chart of zeros doesn't count (could be a KPI). The bar for flagging is high enough that false-positive retries are rare. Single-shot Ask benefits from the same validator, not just Investigate.

---

## The re-planner

This is the keystone. After every wave of sub-questions completes (and before the next dispatches), the orchestrator calls a re-planner LLM with schema-only summaries of every sub-question completed so far. The re-planner returns one of:

- **continue**: plan stays unchanged, proceed to next wave.
- **amend**: append 1-3 new sub-questions to the plan and/or drop any pending ones that are no longer informative.
- **stop**: skip remaining sub-questions, proceed to compose with what we have.

The amendments can reference any sub-question that exists after the amendment — including already-completed ones — so the re-planner can say "drill into the Self-Serve segment from step 2" naturally.

In practice this changes the feel of the tool. On a dataset with a clear concentrated finding (say, one customer segment driving a churn spike), the original plan probably covers the segment breakdown but not the within-segment drill-down. The re-planner sees the concentration in the wave-0 results and adds a follow-up. The user sees a "Planner re-evaluated" entry appear between waves with a one-line rationale, and a new step gets added to the live step list with a flag indicating it was added by the re-planner rather than the original planner.

On a dataset where nothing's interesting (flat metrics, no variance), the re-planner can return `stop` and skip the remaining busywork. Composer runs anyway and produces a brief dashboard saying essentially "nothing here."

Bounded by hard caps: at most 2 re-plan rounds per investigation, at most 10 sub-questions total. The re-planner falls back to `continue` on LLM error or parse failure — forward progress is more important than correctness if the model misbehaves. Cost is about 1-2 cents extra per investigation at Sonnet pricing.

---

## The composer gets one chance to ask for what's missing

After the re-planning loop terminates, there's one more checkpoint before the dashboard composes. The composer gets to inspect the artifacts and decide: "Do I have everything I need to write a coherent narrative answer to the original question?"

If yes, compose. If no, the composer can request 1-2 follow-up sub-questions. The orchestrator runs them as one final wave and only then composes. Common case: you asked about churn rates, the sub-questions returned churn counts, but nobody computed a denominator. The composer can spot this and request "compute total active customers per segment so we can convert counts to rates" before producing the rate-comparison dashboard.

This is one-shot — the composer gets one chance to ask, not an open-ended back-and-forth. If gap-check returns nothing the composer just composes. If it returns needs, those run and then the composer composes regardless of what comes back. The cap (`COMPOSER_MAX_DISPATCHES = 1`) is in the code; the constant exists so we can raise it to 2 later if telemetry says we should.

---

## Privacy posture is unchanged

The new planner, re-planner, and gap-check calls all see SCHEMA + RESULT SUMMARIES only. Result summaries are result-key types ("revenue: number, region: string") and chart-data shapes ("4 rows × [region, revenue, growth]"). Never row values. This matches the existing planner and composer posture — the LLM still never touches data.

For local users running with Ollama, MLX, or llama.cpp, the extra round trips add latency but no privacy surface.

---

## What this still doesn't do

I want to be specific about what we **didn't** ship:

- **No tool use beyond code-gen.** The agent has exactly one verb: write Python or SQL and run it. It can't search the web for context, can't query the warehouse metadata on demand, can't read dbt project files outside the schema-extraction pass that happens at connection time. That's the next milestone.
- **No cross-investigation memory.** Run three Investigates on the same dataset over a week and the planner starts from scratch each time. Past findings, columns that proved useful, dead ends — none of it is retained.
- **No open-ended exploration.** "Find what's interesting" without a starting question still doesn't work because there's no goal-generation step.
- **No hypothesis mode.** The planner picks analysis patterns ("compare", "drill into", "trend"), not hypotheses with falsification analyses.

These are deliberate Tier 2 / Tier 3 items, planned but not started.

---

## What this batch came with

A few other things shipped in the same window:

- **Hex / Julius / Power BI / ThoughtSpot comparison docs updated** with the new agentic capabilities. The Hex comparison in particular is meaningfully tighter than it was in April — Hex still wins on team collaboration, R support, and warehouse breadth, but the AI gap is much narrower.
- **Strategy doc** at `spec/agentic-data-analysis-assessment-2026-05-31.md` walks through the SOTA in agentic data analysis, the capability ladder, where Hermetic sits on it, and what it would take to move further up. If you're interested in the framework I used to plan this work, that's the doc.
- **Two small bug fixes**: LineChart no longer crashes when an LLM-emitted spec omits `y_keys` (now defends across all charts that use the shared color-map hook), and the suggestion pills now respect whichever mode (Ask or Investigate) you have selected in the input rather than always defaulting to Ask.

---

## What's next

The Tier 2 work is multi-tool use. The agent should be able to call out to `searchWeb(query)` when a piece of macro context isn't in the data, `queryWarehouseMetadata(query)` for ad-hoc INFORMATION_SCHEMA lookups, `readDbtModel(name)` for on-demand definition lookups, and `searchPriorAnalyses(query)` once cross-investigation memory exists. Each tool needs its own prompt patterns and (where applicable) sandbox isolation, so it's a real chunk of work — not weeks but not days either.

After that, the cross-investigation memory layer becomes the foundation for hypothesis mode and open-ended exploration, which are where this gets actually interesting.

If you've tried Hermetic and hit an investigation that did something interesting (especially something the re-planner amendment caught that you wouldn't have asked about explicitly), I'd love to know. The clearest signal in my own usage is that I now ask broader questions than I used to — "why did churn spike" rather than "what was churn last quarter by segment" — because the agent fills in the decomposition.

**GitHub**: [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

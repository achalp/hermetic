# Hermetic: the dashboard answers back

**TL;DR**: The last update closed the agent's reasoning loop. This one opens a door into it from the result itself. Click a segment on an Investigate dashboard and you don't get a shallow filter. You get a _scoped sub-investigation_ that goes deeper, carrying the parent's approach and the slice you clicked. Select across charts and hit "Investigate this selection." The notebook view grew real editing and exports (Markdown, self-contained HTML, PDF). The chart library nearly doubled, to 57, spanning statistics, ML diagnostics, and geospatial. Output styles were rebuilt to mean what they say. Every analysis now shows what it cost, and costs less. There's also a real front door, an Opus 4.8 upgrade, and a stack of reliability fixes. Open source, local-first. [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

---

In the [last update](https://www.linkedin.com/pulse/hermetic-closing-agentic-loop-achal-prabhakar-qsrlc) I closed the agentic loop: Investigate became a real plan, act, observe, re-plan cycle instead of a fixed-plan batch executor. That loop lived entirely inside the agent. You asked a question, the agent reasoned, a dashboard appeared, and then you were back at a text box, typing your next question from scratch.

This batch is about the other half of that loop: the result. A dashboard shouldn't be a dead end you read and abandon. It should be a surface you can interrogate. You click into a finding, select across the evidence, and hand the slice back to the agent to go deeper. That's most of what shipped, plus a lot of craft underneath it. It's a wide release, so this is a longer note than usual.

---

## Click a bar, drill in, and the drill is an investigation

Start with the embarrassing-in-hindsight part: drill-down was broken. Clicking a drillable bar, pie, or line chart did nothing at all. The machinery to capture _which_ value you clicked was on `main` and correct; what was missing was the wiring that lets the click reach a handler. The custom `drillDown` action was never registered with the provider, so every click hit "no handler registered" and silently no-op'd. I fixed that, and then found a second bug hiding behind it: the handler _was_ registered, but a state-guard in the dispatch path skipped the action because it was handed a falsy setter. Two layers of "looks wired, isn't." Both are fixed now, with a test that dispatches a real click through the real provider so they can't silently regress again.

With drill-down actually working, the interesting part is what it now does.

When you drill into a segment of an **Investigate** result, or ask a follow-up on one, Hermetic no longer falls through to a shallow single-shot answer. It routes through a **scoped sub-investigation**. The planner is handed the parent investigation's approach, the steps it already explored, and the filters from the segment you clicked, and it's told to go _deeper_ rather than start over. Click the bar for the one customer segment that's driving churn, and the agent plans a fresh decomposition _about that segment_, aware of everything the parent already established. Depth is sticky: follow-ups stay in Investigate by default, and because the scoped plans are smaller, they degrade gracefully to a quick lookup when that's all the question needs.

This is the piece I'm most pleased with, because it's the same idea as the re-planner from last time, turned outward. The agent re-plans against its own findings, and now _you_ can re-enter the loop by pointing at one.

---

## Select across charts, then "Investigate this selection"

Drill-down answers "tell me more about this one bar." The companion interaction answers "tell me more about _this slice across the whole dashboard_."

Click a chart segment and it now **selects and highlights**, and every other chart built on the same column highlights with it, so you can see your selection reflected across the evidence at a glance. Then an **"Investigate this selection →"** bar appears, and acting on it re-runs the analysis scoped to exactly what you selected, across every filter you've set.

There's an honest engineering decision in here that's worth spelling out, because it's the kind of thing that's tempting to fake. Ask mode has instant client-side cross-filtering: its charts are declarative recipes the browser can recompute on the fly from one dataset. Investigate's charts are not. They're produced by arbitrary server-side Python (regressions, rolling averages, correlations, custom transforms) that simply cannot be replayed in the browser. The tempting shortcut is partial client-side filtering: let the simple charts update instantly and leave the complex ones stale. I didn't do that, because a dashboard where half the charts silently reflect your selection and half don't is worse than one that's honest about needing a real re-run. So the shared interaction in both modes is a correct, server-scoped re-run, and Ask keeps its instant preview as a bonus on top, where it's actually correct. The _action_ is identical in both modes (click, select, investigate), and it never lies about what it's showing you.

---

## The notebook grew up, and you can ship it

An Investigate run has always had a narrative behind the dashboard: the sub-questions, the code, the intermediate results. This batch turned that into an editable, exportable notebook.

You can now **author markdown cells** in the notebook view, insert them anywhere, and reorder cells; the layout persists and rides along into your saved history for free. It's a real "show your work" surface. The dashboard is the answer, the notebook is the reasoning, and you can annotate it.

And it **exports**, into the format that fits the audience:

- **Markdown**: the text-native one. Each cell in order, with its question, SQL, Python, the lifted insight, a data-preview table, and the closing synthesis. Pure and dependency-free.
- **Self-contained HTML**: a single file with the styles inlined and every chart embedded as a base64 image. Drop it on S3, Google Drive, or any static host and it renders as-is, with no external requests and no server. This is the "send the analysis to someone who doesn't have Hermetic" format.
- **PDF**: a flat, faithful render of the notebook with the charts intact.

All of it flows through one **context-aware Export menu** now, instead of two competing export UIs. The dropdown offers Markdown, HTML, and PDF when you're in the notebook, and PDF, DOCX, and PPTX when you're on the dashboard, each capturing the right part of the page.

Underneath, re-runs got more honest too. Each step's _full_ output is now persisted (not just the 200-row preview you see in a cell), so when you re-run a downstream step, it sees its upstream's complete data rather than a truncated slice. The row cap is now purely cosmetic. The dataflow, on both the first run and every re-run, is full-fidelity end to end.

---

## The chart library nearly doubled, to 57

The composer can only reach for a chart that exists, so "what can Hermetic draw" is a direct ceiling on "what can Hermetic answer." This batch raised that ceiling hard, adding roughly two dozen chart types across four themed batches, taking the library from the low-30s to **57**.

- **Statistics:** Pareto, Q-Q, ECDF, Kaplan-Meier survival, forest plots, control / SPC charts, ACF correlograms, error bars / confidence intervals.
- **ML diagnostics:** ROC and calibration curves, lift / cumulative-gain, partial dependence (PDP/ICE), confusion matrix, SHAP beeswarm, dendrograms, silhouette plots, network graphs.
- **KPI & commerce:** dual-axis, funnel, gauge, bullet, waterfall, marimekko, sparkline.
- **Scientific & geospatial:** contour / density, ternary, population pyramid, Gantt, cohort retention grids, quiver (vector) fields, wind rose, plus the existing 3D and deck.gl map layers.

None of these are decorative; they're the visual vocabulary an actual analyst reaches for, the difference between "here's a chart of the numbers" and "here's a survival curve, a calibration plot, a control chart with its limits." As always, you never pick one: the composer selects from all 57 based on the question and the shape of the answer. A reliability pass came with them: tolerating the messy data shapes real LLMs emit, repairing drifted chart bindings, and a smoke fixture so a chart that renders blank fails CI instead of shipping.

---

## Output styles say what they mean now

The query-bar "styles" had drifted into mislabels. The default literally ran the wrong prompt. They're rebuilt around a clear principle: **a style governs the _form_ of the answer, not its content.** The model still decides how many charts, which types, and how much. That comes from the question and the data. The style decides the frame it's poured into. Four of them now, each a real consumption context:

- **Dashboard**: a true at-a-glance grid.
- **Brief**: one screen, bottom-line-up-front.
- **Report**: a sectioned document (this absorbed the old "Narrative").
- **Deep dive**: exhaustive, multi-angle.

Investigate honors the style now too, modulating the synthesized dashboard's density and tone. Slides moved to where it belongs: an _export_ (a Reveal deck or PPTX), not a pretend analysis style. There's a visible morph animation when you switch a result's form so the change reads as intentional, and one-line hover descriptions so you know what you're choosing. Old style ids still resolve via aliases, so saved defaults and saved dashboards don't break.

---

## A meter on the agent, and a smaller bill

An agent that quietly fires 15 to 30 model calls per question owes you a number. Now you get three:

- A **footer** showing the cost of the last analysis and your running session total.
- A **`/cost` page** with totals and a per-dataset breakdown.
- A **per-day CSV** (`data/cost/<date>.csv`): one row per analysis with the token buckets and dollar cost, so you can analyze your own usage in the tool that analyzes things.

It was nearly free to build because every model call already routes through one factory. A middleware on it reports usage into a per-request accumulator, and the whole Investigate fan-out sums up implicitly, with no cost parameter threaded through forty functions. Local models read $0 but still track tokens.

And the number went _down_. The biggest lever was the dullest. An Investigate run re-sent the same large, static prompts (the code-gen instructions, the JSON-Render component catalog) on every one of its calls, paying full price each time. Prompt caching on the direct Anthropic path now bills those re-sent tokens at the cache-read rate after the first call, roughly a 90% discount on the repeated input, which is exactly the shape a fan-out wants. Fewer redundant retries and lazy cell composition trimmed the rest.

---

## A front door that sells the actual pitch

The home screen used to bury the one thing that makes Hermetic different in a 12-pixel footnote. It now leads with it: **the model writes the analysis code, but never sees your rows.** It shows real generated dashboards _before_ you upload anything, so a first-timer sees the payoff up front. The dashed drop zone finally accepts a dragged-in file (it had always looked like it should), and the one-click sample dataset is where a curious visitor can actually find it.

---

## Plumbing worth mentioning

A release this wide carries a lot of less-glamorous work that still matters:

- **Opus is now 4.8**, across all three cloud paths (Anthropic, Bedrock, Vertex). It had been pinned two versions back. Bumping it surfaced a pricing bug the new cost meter made impossible to ignore: Opus was priced at the old Claude 3 rate ($15/$75 per million), three times its real $5/$25, so every Opus run had been over-reported by 3x. Fixed. (The upgrade also needed a small shim: Opus 4.7+ rejects the `temperature` parameter outright, so it's stripped for exactly those models.)
- **Reliability for the weak-local-model long tail.** Generated code no longer crashes when a small model reaches for `pd.read_excel` on the CSV the sandbox actually hands it (rewritten to `read_csv` before it runs), or emits hard-coded `assert corr == 0.785`-style self-tests that fail on perfectly valid data. The whole point of local mode is that the small model has to work.
- **Saved warehouse connections stopped being a dead end.** You can now expand a saved connection to view and copy every config field (secrets masked behind a reveal toggle, a real relief for BigQuery, where you used to re-paste the service-account JSON from scratch), and give it an editable friendly name that survives a password rotation.
- **Infrastructure:** migrated to pnpm 10 with a registry-agnostic lockfile (clean installs against the public registry or a corporate Artifactory mirror), upgraded CI, and added a large round of test coverage. The suite is now well into the hundreds of tests gating every merge.

---

## Privacy posture is unchanged

Worth restating every release, because it's the reason the project exists: none of this changes what leaves your machine, which is still nothing. Drill-downs and "investigate this selection" re-runs go to _your_ sandbox and _your_ configured model, schema-and-results only. The LLM still never touches a row of your data. The cost meter is accounting read off the model's own responses, not telemetry phoned home. The exported HTML is a file on your disk. And on local models, the privacy surface is exactly what it always was.

---

## What's next

I'll be straight about what this batch wasn't: it didn't climb the agentic capability ladder. The Tier-2 work I pointed at last time, giving the agent tools beyond writing code, I've actually walked back from in the strategy doc, because web search breaks the privacy-and-verifiability guarantee and most of the rest is ladder-chasing. What this batch did instead was make the loop you _can_ trust feel like a workspace you can click into, re-investigate, export, and run for a lot less.

The thread I want to pull next is budgets. Now that an investigation knows what it's spending as it spends it, it can be handed a ceiling ("you have N cents and ~20 calls for this question") and let the re-planner weigh a follow-up wave against what's left. An agent that can see its own bill can start to reason about it. That's the bridge from metered to self-pacing.

If you run Hermetic and a drill-down amendment caught something you wouldn't have thought to ask, or the cost page told you something surprising, I'd genuinely like to hear it. The clearest signal in my own use is that I now click into dashboards instead of retyping questions, which is exactly what I was hoping for.

**GitHub**: [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

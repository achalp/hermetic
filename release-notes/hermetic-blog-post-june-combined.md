# Hermetic in June: click into the answer, point it at your warehouse, and trust the number

**TL;DR (10 seconds):** Hermetic is an open-source, local-first AI data analyst — it writes the analysis code but **never sees your rows**. This month it got three big upgrades:

1. **Dashboards you can click into.** Drill into a finding and the agent runs a _deeper investigation_ of that slice — not a dumb filter.
2. **It runs on your warehouse now.** Point it at a billion-row BigQuery or ClickHouse table and it answers reliably — for about **\$0.28 a run** (down from \$1+).
3. **A hard pass on reliability and trust.** Self-healing queries, dashboards that never white-screen, and every number in the write-up checked against what was actually computed.

Plus 57 chart types, an editable/exportable notebook, output styles that mean what they say, and a live cost meter. [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

---

Two months ago I closed the agent's _reasoning_ loop: Investigate became a real plan → act → observe → re-plan cycle. But that loop lived entirely inside the agent. You asked, a dashboard appeared, and then you were back at a blank text box.

June was about the two things that turn a clever demo into a tool you'd actually use: **make the result something you can click into and interrogate**, and **make the agent something you can point at real, messy, enormous data and believe.**

---

# What's new

## 🖱️ Click a bar, and the drill-down is an investigation

Click a segment of an Investigate dashboard and Hermetic no longer gives you a shallow filter. It runs a **scoped sub-investigation**: the planner gets the parent's approach, the steps already explored, and the exact slice you clicked, and it goes _deeper_.

Click the bar for the one customer segment driving churn, and the agent plans a fresh analysis _about that segment_ — aware of everything the parent already found. The re-planner from last release, turned outward: now **you** can re-enter the loop by pointing at a finding.

## 🔦 Select across charts, then "Investigate this selection"

Click a chart segment and it highlights — and so does every other chart built on the same column, so your selection reflects across the whole dashboard at a glance. An **"Investigate this selection →"** bar appears, and acting on it re-runs the analysis scoped to exactly what you picked.

(One honest call: Investigate's charts are arbitrary server-side Python — regressions, rolling averages, custom transforms — that _can't_ be replayed in the browser. The tempting shortcut is to let the simple charts update live and quietly leave the hard ones stale. I didn't. A dashboard that's half-honest is worse than one that does a real re-run.)

## 🏢 It runs on your data warehouse

The big new capability: connect a real warehouse — **BigQuery, ClickHouse, Snowflake, Postgres, Databricks, Trino** — ask in plain English, and Hermetic writes the SQL, runs it, and builds the dashboard. I tested it against live public tables in the **billions of rows**, and it holds up. That "holds up" is the whole story of the reliability section below.

## 📓 A notebook you can edit — and ship

Every Investigate has a narrative behind the dashboard: the sub-questions, the code, the results. It's now an **editable notebook** — author markdown cells, reorder, annotate — that **exports** to:

- **Markdown** — text-native, dependency-free.
- **Self-contained HTML** — one file, charts embedded, no server. Drop it anywhere and it just renders. The "send it to someone who doesn't have Hermetic" format.
- **PDF** — flat and faithful.

## 📊 57 chart types

The composer can only reach for charts that exist, so the library _is_ the ceiling on what Hermetic can say. It nearly doubled — survival curves, calibration plots, control charts, SHAP beeswarms, funnels, cohort grids, quiver fields, wind roses. The visual vocabulary an actual analyst reaches for. You never pick one; the composer selects from all 57 based on the question.

## 🎛️ Output styles that mean what they say

The query-bar styles had drifted into mislabels (the default literally ran the wrong prompt). Rebuilt around one principle: **a style governs the _form_ of the answer, not its content.** Four real consumption contexts — **Dashboard** (at-a-glance grid), **Brief** (one screen, bottom line up front), **Report** (sectioned document), **Deep dive** (exhaustive). Investigate honors them too. Slides moved to where it belongs: an _export_, not a pretend analysis mode.

## 💸 A cost meter — and a smaller bill

An agent that quietly fires 15–30 model calls per question owes you a number. Now you get three: a live **footer** (last run + session total), a **/cost page** (totals, per-dataset breakdown), and a **per-day CSV** you can analyze in the tool that analyzes things.

And the number went _down_. A representative warehouse investigation fell from **~\$1.04 → ~\$0.28** — by caching the big static prompts a fan-out re-sends, scaling analysis depth to the question (a Brief asks 3 sharp sub-questions, not 5 scattered ones), and aggregating in the warehouse instead of hauling a million-row frame into Python.

---

# Reliability: it holds up on real data now

The headline feature is "point it at your warehouse." It only matters if it doesn't fall over. So most of June was the unglamorous engineering behind that — here are the fixes that change what you'll actually experience, biggest first.

- **Warehouse queries don't choke on big tables.** Before generating SQL, Hermetic sizes a safe scan window from the engine's _metadata_ (not by scanning the table), so a billion-row table never trips the "rows to read exceeded" limit. If a query still fails, it **self-heals** — the exact engine error is fed back to the model, which fixes and retries. A failed query is now a conversation, not a dead end. (Both single-shot Ask and the deep Investigate run through this same hardening.)

- **No more silently-biased answers.** The old design analyzed the first 50,000 rows of a table — which on a billion rows isn't a sample, it's "whatever sorted first," and every average computed on it is quietly wrong. Now each question writes its own SQL that aggregates over the **full population** in the warehouse and returns a small, honest result. Nothing is sampled behind your back.

- **One broken chart no longer blanks the whole dashboard.** A single chart hitting an edge case used to take the entire page down to a white screen. Now each component is isolated: the rest of the dashboard renders, and the one that failed shows a small labeled tile instead.

- **Drill-down actually works.** Embarrassing in hindsight: clicking a drillable chart did _nothing_ — two layers of "looks wired, isn't." Fixed, with a test that dispatches a real click so it can't silently regress.

- **Local models behave.** Generated code no longer crashes when a small model reaches for `read_excel` on a CSV, or writes hard-coded `assert corr == 0.785` self-tests that fail on perfectly valid data. Local mode only matters if the small model actually works.

- **A robot now tests it for me.** I built an autonomous end-to-end test that connects a real warehouse, runs a full investigation, and checks the result. On its _first run_ it confirmed a fix **and** caught a brand-new bug I'd never have found by hand. Catch → fix → verify, without me reading a log.

_Under the hood:_ Opus upgraded to 4.8 across all cloud paths; every run writes a structured diagnostics record so "why did this cost/behave this way" is answerable from data; and the test suite is well into four figures, gating every merge.

---

# Trust: the interface never shows you something untrue

Reliability is "it works." Trust is "you can believe what it tells you." That's the line the whole project is built on.

- **The model never sees your data.** Still the reason Hermetic exists: it writes the analysis _code_, which runs in _your_ sandbox against _your_ rows. Drill-downs, warehouse queries, "investigate this selection" — all of it is schema-and-results only. The cost meter is accounting read off the model's own replies, not telemetry phoned home. Nothing leaves your machine.

- **Every number is grounded.** Each figure in a dashboard's write-up is checked against what the analysis actually computed. A number that traces to nothing gets a quiet **"verify this"** caveat instead of being stated as fact — and crucially, the check was tuned so it _doesn't cry wolf_ on real, correctly-computed numbers (the whole point of a warning is that you can trust it when it fires). This now runs on **both** single-shot dashboards and deep investigations.

- **No placeholder gibberish.** When the composer referenced a value that was never computed, a raw `$result:step_1_title` token used to leak onto the screen. It's now blanked and logged, so it never reaches you — and we get a signal when the model drifts.

- **The trail can't vanish.** Reopen a result after the in-memory cache expired and the panel used to go blank, even though the full code-and-data trail was safe on disk. Now it falls back to history seamlessly. The data was always there; the view just couldn't reach it.

---

# What's next

I'll be straight: June didn't climb the agentic-capability ladder, and that's on purpose — web search would break the privacy guarantee, and most of the rest is ladder-chasing. June made the loop you _can_ trust into a workspace you can click into, point at real data, and run for pennies.

The thread I want to pull next is **budgets**. Now that an investigation can see what it's spending as it spends it, you could hand it a ceiling — "you have N cents and ~20 calls for this question" — and let it weigh a follow-up against what's left. An agent that can see its own bill can start to pace itself.

If you run Hermetic and a drill-down caught something you wouldn't have thought to ask — or the cost page surprised you — I'd genuinely like to hear it.

Open source, local-first. ⭐ [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

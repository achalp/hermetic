# Hermetic in June: clicking into answers, querying warehouses, and trusting the numbers

I work on Hermetic, an open source, local first AI data analyst. The model writes the analysis code, but it never sees your actual rows. Here is what changed in June, and a fair amount of what I got wrong along the way.

If you only have a minute, three things happened:

1. You can click into a dashboard now. Drill into a finding and the agent runs a deeper investigation of that slice, not just a filter.
2. It works on real data warehouses. You can point it at a billion row BigQuery or ClickHouse table and get an answer back, for roughly 28 cents a run. It used to cost over a dollar.
3. I spent most of the month on reliability and trust, because the first two only matter if you can believe the result.

There is more below (57 chart types, an editable notebook you can export, a live cost meter), but those three are the heart of it.

Two months ago I closed the agent's reasoning loop, so Investigate became a real plan, act, observe, re-plan cycle instead of a fixed script. The trouble was that the loop lived entirely inside the agent. You asked a question, a dashboard appeared, and then you were back at a blank text box. June was about two things I had been putting off because they are harder than they look: making the result something you can poke at and follow up on, and making the agent something you can point at real, large, messy data without it quietly falling apart.

## What's new

### Clicking a chart starts an investigation, not a filter

When you click a segment of an Investigate dashboard, Hermetic no longer hands you a shallow filter. It runs a scoped sub-investigation. The planner gets the parent's approach, the steps already explored, and the exact slice you clicked, and it is told to go deeper.

So you click the bar for the one customer segment that looks like it is driving churn, and the agent plans a fresh analysis about that segment, aware of everything the parent already found. It is the re-planner from last release, pointed outward. Now you can re-enter the loop by pointing at a finding, instead of retyping a question.

This is the part I am happiest with, mostly because it is the thing I find myself actually doing.

### Select across charts, then investigate the selection

Click a chart segment and it highlights, and so does every other chart built on the same column, so you can see your selection reflected across the whole dashboard. A small bar appears offering to investigate that selection, and acting on it re-runs the analysis scoped to exactly what you picked.

There is an honest tradeoff worth admitting here. Investigate's charts are arbitrary server side Python (regressions, rolling averages, custom transforms) that cannot be replayed in the browser. The tempting shortcut is to let the simple charts update instantly and quietly leave the hard ones stale. I decided not to, because a dashboard where half the charts reflect your selection and half silently do not is worse than one that is honest about needing a real re-run.

### It runs on your data warehouse

You can connect a real warehouse now (BigQuery, ClickHouse, Snowflake, Postgres, Databricks, Trino), ask in plain English, and Hermetic writes the SQL, runs it, and builds the dashboard. I tested it against live public tables in the billions of rows. Getting it to actually hold up there is most of what the reliability section below is about, so I will not oversell it here.

### A notebook you can edit, and export

Every Investigate has a narrative behind the dashboard: the sub-questions, the code, the intermediate results. That is now an editable notebook. You can write markdown cells, reorder them, and annotate the reasoning. And it exports three ways:

1. Markdown, for something text native and dependency free.
2. A single self contained HTML file with the charts embedded, so you can drop it anywhere and it just renders, no server needed. This is the format for sending an analysis to someone who does not run Hermetic.
3. PDF, for a flat, faithful copy.

### 57 chart types

The composer can only reach for charts that exist, so the chart library quietly sets the ceiling on what Hermetic can say. It nearly doubled this month, to 57: survival curves, calibration plots, control charts, SHAP beeswarms, funnels, cohort grids, quiver fields, wind roses, and more. You never pick one yourself. The composer chooses from all of them based on the question and the shape of the answer.

### Output styles that mean what they say

The styles in the query bar had drifted into mislabels, and the default was honestly running the wrong prompt. I rebuilt them around one idea: a style should govern the form of the answer, not its content. There are four now, each a real way you might want to consume a result. Dashboard is an at a glance grid. Brief is one screen with the bottom line up front. Report is a sectioned document. Deep dive is exhaustive. Investigate respects them too.

### A cost meter, and a smaller bill

An agent that quietly makes 15 to 30 model calls per question should tell you what that cost. It does now, in three places: a footer with the last run and your session total, a cost page with a per dataset breakdown, and a per day CSV you can open in the tool that opens CSVs.

The number also came down. A representative warehouse investigation went from about a dollar to about 28 cents over the month. Most of that came from caching the large static prompts a fan out re-sends on every call, scaling how deep the analysis goes to the actual question (a Brief asks 3 sharp sub-questions instead of 5 scattered ones), and aggregating inside the warehouse rather than dragging a million row table into Python.

## Reliability: making it hold up on real data

The headline is "point it at your warehouse," and that only means anything if it does not fall over. So most of June was the unglamorous work behind that. Here are the fixes that change what you will actually experience, roughly in order of how much they matter.

The biggest one is that warehouse queries no longer choke on large tables. Before generating SQL, Hermetic now sizes a safe scan window from the engine's metadata, without scanning the table, so a billion row table does not blow past the read limit. If a query still fails, it repairs itself: the exact engine error is fed back to the model, which fixes the query and retries. A failed query has become a short conversation with the database instead of a dead end. Both the quick single shot Ask and the deeper Investigate run through the same hardening, so I am not fixing the same thing twice.

Related to that, answers are no longer quietly biased. The old design analyzed the first 50,000 rows of a table, which on a billion rows is not a sample, it is just whatever happened to sort first, and every average computed on it is subtly wrong. Now each question writes SQL that aggregates over the full population in the warehouse and brings back a small, honest result. Nothing gets sampled behind your back.

A few more that I think you will feel:

1. One broken chart no longer blanks the whole dashboard. A single chart hitting an edge case used to take the entire page down to a white screen. Each component is isolated now, so the rest renders and the one that failed shows a small labeled tile.
2. Drill down actually works. This is embarrassing in hindsight: clicking a drillable chart did nothing at all, through two separate layers of "looks wired, is not." It is fixed, with a test that dispatches a real click so it cannot quietly break again.
3. Local models behave better. Generated code no longer crashes when a small model reaches for an Excel reader on a CSV, or writes a hard coded self test that fails on perfectly valid data.

And one I am quietly proud of: I built a test that does my manual checking for me. It connects a real warehouse, runs a full investigation, and verifies the result. On its very first run it confirmed a fix and also caught a brand new bug I would not have found by hand. That is the loop I want, running without me reading a single log.

Underneath all of this, Opus moved to 4.8 across the cloud paths, every run now writes a small diagnostics record so I can answer "why did this cost or behave this way" from data instead of memory, and the test suite is well into four figures and gates every change.

## Trust: not showing you anything untrue

Reliability is "it works." Trust is "you can believe what it says." That second one is the reason the project exists, so I take it seriously even when it is inconvenient.

The foundation has not changed: the model never sees your data. It writes the analysis code, and that code runs in your sandbox against your rows. Drill downs, warehouse queries, follow ups, all of it is schema and results only. The cost meter is just accounting read off the model's own replies, not telemetry sent anywhere.

On top of that, every number in a write up is now grounded. Each figure in the narrative is checked against what the analysis actually computed, and anything that traces to nothing gets a quiet "verify this" caveat instead of being stated as fact. I spent real effort making sure it does not cry wolf, because a warning that fires on correct numbers is worse than no warning at all. This runs on both single shot dashboards and deep investigations now.

Two smaller honesty fixes round it out. When the composer referenced a value that was never computed, a raw placeholder token used to leak onto the screen. It is now blanked and logged, so you never see it and I get a signal when the model drifts. And reopening a result after an in memory cache expired used to show a blank panel, even though the full code and data trail was sitting safely on disk. It falls back to that history now. The data was always there, the view just could not reach it.

## What's next

I will be honest about what June was not. It did not climb the agentic capability ladder, and that was deliberate. Web search would break the privacy guarantee, and a lot of the rest is ladder chasing. What June did instead was make the loop you can already trust into something you can click into, point at real data, and run for pennies.

The thread I want to pull next is budgets. Now that an investigation can see what it is spending as it spends it, I could hand it a ceiling, something like "you have N cents and about 20 calls for this question," and let it weigh a follow up against what is left. An agent that can see its own bill can start to pace itself.

If you run Hermetic and a drill down caught something you would not have thought to ask, or the cost page told you something surprising, I would genuinely like to hear about it.

Open source, local first. github.com/achalp/hermetic

# Hermetic: the agent goes to the warehouse

**TL;DR**: The last update made the dashboard something you could interrogate. This one makes the agent something you can point at a real data warehouse — a five-billion-row BigQuery table, a ClickHouse fact table — and trust. I ran Investigate against live public warehouses and watched it fail in a dozen quiet ways: biased samples, runaway scans, queries that returned nothing and retried forever, costs north of a dollar a run. This batch is the systematic fix. Investigate now bounds its scans from engine metadata, writes per-step SQL that aggregates over the full population, repairs its own failed queries, and writes a diagnostics record for every run. Along the way the cost of a deep investigation fell from **~\$1.00+ to ~\$0.28**, measured at every step rather than guessed. And there's now an **autonomous end-to-end test** that runs a real investigation and checks the result — which earned its keep by catching a bug on its first run. Open source, local-first. [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

---

In the last update I turned the result surface into something interactive: click a finding, select across the evidence, hand the slice back to the agent. That work assumed the agent underneath was solid. Then I pointed Investigate at data that didn't fit in memory — public BigQuery and ClickHouse tables in the billions of rows — and found out how much "solid on a 50,000-row CSV" doesn't transfer to "solid against a warehouse."

This note is about closing that gap. It's less about new surface area and more about the unglamorous engineering that makes a deep, multi-step investigation actually work against real data, at a cost you'd run more than once. There's a theme running through all of it: **measure, don't guess** — and the tooling I built so I could.

---

## The data is what it is

The first thing I got wrong was a cap. To keep a warehouse pull from exhausting memory, Investigate materialized at most 50,000 rows and analyzed those. The problem isn't the number — it's that 50,000 rows of a billion is not a sample, it's _the first 50,000 by sort order_, and every count, rate, and average computed on it is quietly biased. The tool was producing confident answers to "which checks fail most often" from a window that happened to be whatever the table sorted to first.

The honest fix isn't a bigger cap — it's to stop pretending a row-limited slice represents the whole. Two changes got there. First, the in-memory ceiling went up by raising it the right way: large pulls are converted to **Parquet and analyzed through DuckDB** before pandas ever sees them, so aggregation happens in a columnar engine and the practical limit moved well past a million rows (fallback-safe to the old CSV path if anything in the Parquet conversion fails). Second — and this is the one that actually mattered — I stopped materializing a broad slice at all for the questions that need full-population math.

---

## Per-step SQL: aggregate where the data lives

Here's the bet the old design made: pull one broad snapshot up front, then answer every sub-question by analyzing that shared snapshot in Python. The appeal is amortization — one expensive pull, many cheap analyses.

The diagnostics (more on those below) showed the bet didn't pay. On a warehouse, the snapshot is a capped, filtered sample, so a conservative "did this actually answer the question" judge rejected it on nearly every sub-question — 3 of 4, then 5 of 5 in two real runs — and each rejection first paid for a _discarded_ snapshot analysis before falling back to a real query. We were paying for the broad pull **and** the per-step query **and** a judge to discover the snapshot was inadequate. The amortization never happened.

So I inverted it. For warehouse sources, each sub-question now generates **its own targeted SQL** that aggregates server-side over the full population and returns a small, tidy result. No shared snapshot, no sufficiency judge, no sampling bias — the aggregation runs in the warehouse over every row, and code-gen then works over kilobytes instead of a million-row frame. The sampling problem disappears at the root, because nothing is sampled. (File uploads keep the analyze-in-DuckDB path — there's no warehouse to query, the file _is_ the data.)

This deleted three things at once: the cost doubling, an LLM call per step, and the bias. It's a good reminder that the cheapest optimization is often a worse architecture wearing a caching hat.

---

## Don't scan a billion rows to find the recent ones

Per-step SQL only works if each query is cheap, and on a huge table the way you make a query cheap is to **bound the scan** — a tight `WHERE` on the partition or date key that prunes how much data the engine reads. The trick is knowing the right window without scanning the table to find it.

Engines already know. So Hermetic now sizes a recent window from **metadata, not data**:

- **ClickHouse:** the table's sort-key bounds (gated on `system.tables`, since read-only playground users don't get `system.parts`).
- **BigQuery:** `INFORMATION_SCHEMA.PARTITIONS` gives the partition values _and_ per-partition row counts — date range and density, for free, on exactly the column that prunes the scan — with a `MIN/MAX` fallback on a real date column for non-partitioned tables.

That window goes to SQL-gen as a hard constraint, so the model can't guess a too-wide range.

The most instructive bug here was BigQuery-specific and worth telling on myself. The model kept filtering on `_PARTITIONTIME` — BigQuery's ingestion-time pseudo-column — because my prompt hammered "bound the scan on the partition key." But on a table that _isn't_ ingestion-time partitioned, `_PARTITIONTIME` is `NULL` for every row, so the filter excluded everything and the query returned zero rows. Worse, the repair loop just shifted the empty window to another empty quarter, three times, then gave up. The fix was two-part: teach the dialect prompt that `_PARTITIONTIME` is a trap unless the table is genuinely ingestion-partitioned, and teach the repair loop that **zero rows means your filter is wrong** — reconsider the column or drop the speculative filter, don't just slide the window. A failed query is now a conversation with the engine's error, not a fixed retry.

---

## Make it cheap — and prove it, lever by lever

A deep investigation fans out into a lot of LLM calls, and early warehouse runs cost over a dollar each. I refused to optimize that by feel, so the first thing I built was **per-phase cost attribution**: every model call is tagged with its phase (planner, SQL-gen, SQL-repair, code-gen, compose, …) via an async-local context, and each run's cost is broken down by phase in the daily CSV. Now "where does the money go" is a measurement.

It immediately overturned my assumptions. Compose wasn't the cost king — code-gen was, and on hard questions the table schema sent to SQL-gen dominated _input_ cost. With that map, the levers became obvious and each one was verifiable against the next run's breakdown:

- **Prompt caching across the fan-out.** The big static system prompt and the warehouse schema are cached and pre-warmed before the first parallel wave, so sub-questions read a warm cache instead of each cold-writing it. (Repairs reuse the same cached prefix.)
- **Depth scaled to intent.** The output style now reaches the _planner_, not just the composer: a Brief targets ~3 penetrating sub-questions, a Report ~4, a Deep dive goes wide. Since cost is roughly linear in sub-question count, and runs were defaulting to ~5 regardless of intent, this was the single biggest lever — a dashboard dropped from 5 sub-questions to 3.
- **Per-step SQL** (above) collapsed code-gen from working over a million-row frame to a small aggregate.
- **Skip the prewarm** when a plan is only 1–2 steps, because the cache write doesn't pay off across so few reads.

The result: a representative warehouse investigation went from **~\$1.04, to ~\$0.42, to ~\$0.28** across the batch.

One lever I _didn't_ pull is worth a sentence, because the discipline cut both ways. SQL-gen is a third of the remaining cost and an obvious candidate to move to a cheaper model. I tested it — replayed a real run's sub-questions through Haiku against the actual schema — and it was correct on simple aggregation but **silently wrong** on the analytically demanding one (a tautological conditional probability, lift omitted entirely), in valid SQL that _runs_, so no error would catch it. Measuring is also how you learn which optimizations to refuse.

---

## See what it did

The reason I could diagnose the snapshot-judge waste at all is that I rebuilt run observability. The old failure log appended one CSV row per failure and **raced** — parallel sub-questions clobbering each other's writes, so a 12-call run logged 2. And it only recorded failures, missing the thing that actually drove cost: escalation.

Now every run accumulates structured events in memory and writes **one JSON record at the end** (atomic append, no race) to `data/diagnostics/<date>.jsonl`: the materialization (rows, sampled, Parquet, SQL repairs), each sub-question's path and escalations and retries and final status, an aggregate summary, and the cost. "Why did this run cost \$1.04" stopped being an archaeology exercise — the record said `escalated: 5`, and the fix followed directly.

---

## Don't lie to the user

A few correctness fixes that all share a principle: the interface should never show something that isn't true.

- **The trail survives a cold cache.** The artifacts and notebook read from a 10-minute in-memory cache; once it expired, the panel went blank even though the run's full trail was safely on disk in history. Now a cache miss falls back to the persisted history entry and re-warms — the data was always there, the view just couldn't reach it. Lazily-composed notebook cells now persist too, so a reopened notebook doesn't pay to recompose them.
- **No raw placeholders.** The composer references computed values through `$result:` placeholders that get resolved server-side. When it named a key that was never computed, the unresolved token leaked to the screen literally (`$result:step_1_title`). A final sweep now blanks any survivor — and logs it, because a recurring one is a signal that the composer prompt is drifting.
- **Grounding that doesn't cry wolf.** Every Investigate narrative is checked: each figure in the prose must trace to a value the analysis actually computed, or it's flagged "verify this." Two false positives got fixed — the sample size (a known provenance number, not a hallucination) and, subtly, figures cited straight from a step's **data table** rather than its scalar results. The grounding now checks the datasets too, so genuinely-computed numbers stop getting a scary caveat. The point of the warning is trust; a warning that fires on correct numbers erodes exactly that.

---

## Test it without me watching

All of the above was found the slow way: run an investigation, read the logs, paste them back, reason, fix, repeat. That doesn't scale, and it doesn't guard against regressions. So I built an **autonomous end-to-end test** — no browser required. It registers a real BigQuery connection, runs a full investigation against the running server, consumes the streamed result, and asserts the invariants this whole batch was about: the run didn't abort, no raw placeholder leaked, no figure was falsely flagged, the dashboard composed real charts, and the artifacts trail is retrievable with per-step code.

On its very first run — against the same SEC dataset that had been aborting days earlier — it did two things at once. It **confirmed** the end-to-end fix: the investigation that failed three times now completed cleanly, with charts and a persisted trail. And it **caught a new bug** I'd never have found from logs: a grounding false-positive on real `median_revenue` figures the composer had pulled from a dataset table. I fixed it and re-ran the harness to green. That's the loop — catch, fix, verify — running without me reading a single log line.

A real browser layer (Playwright, for pixel-level rendering checks) is the obvious next step, but this API-level harness already covers every data-path regression in this batch, for a few cents a run.

---

This was a less visible release than the last one — no new charts, no new interactions. It's the batch that takes "Investigate is a neat demo on a CSV" and makes it "Investigate is something you can run against your warehouse, more than once, and believe." The agent learned to be careful with data it can't hold, honest about what it computed, and cheap enough to use — and it's now watched by a test that won't let those slip.

Open source, local-first. [github.com/achalp/hermetic](https://github.com/achalp/hermetic)

# Hermetic in July: pointing it at the whole planet

I work on Hermetic, an open source, local first AI data analyst. The model writes the analysis code, but it never sees your actual rows. Here is what changed in July, and the usual share of what I got wrong on the way.

If you only have a minute, three things happened:

1. You can point it at a raw cloud dataset now. Give it an S3 or HTTPS Parquet URL — Overture Maps' 2.5 billion buildings, say — and it queries the file in place. No download, no warehouse, no ETL.
2. It can answer planet-scale questions without reading the planet. "Which is the loneliest building on Earth?" over those 2.5 billion rows comes back in minutes, because it reads the file's own metadata to skip almost everything.
3. I stopped killing your analysis, then spent a while fixing everything that removing the timeout exposed. Long analysis is a first-class thing now, with a Stop button and live progress instead of a guillotine at 20 minutes.

Under those, the middle of the month was a full codebase review and the long remediation that followed — security, trust, and tests. Not exciting, but it is why the first three are safe to use.

June was about pointing Hermetic at your warehouse. July turned out to be about pointing it at data that lives nowhere in particular — a file on the open internet, billions of rows wide — and getting an honest answer back without moving it.

## What's new

### Connect a cloud dataset directly

There is a new data source: remote cloud Parquet. Paste an `s3://` or `https://` URL (a single file, a folder, or a Hive-partitioned dataset like Overture), and Hermetic reads it in place through DuckDB — introspecting the schema, generating the analysis, and running it, all without copying the data anywhere. The file browser was extended to reach both local files and cloud sources, and the sandbox image now bundles the DuckDB httpfs and spatial extensions so this works out of the box.

The privacy line holds exactly as before: the analysis code runs in your sandbox against the data, and the model only ever sees the schema and the computed results. A public URL does not change that.

### Answering superlatives over a planet, without scanning it

Ask for the most isolated building on Earth and the naive plan — a nearest-neighbor across every building — is a non-starter at billions of rows. But a Parquet file carries its own footer: per-row-group statistics, the min and max of every column, readable without touching the data. Hermetic now reads that metadata first, uses it to rule out the vast majority of the file, pulls only a sparse tail of real candidates, and finds the true answer with a proper spatial index. Coarse to fine, cheapest step first.

The part I care about most is that this is not wired to one dataset. Hermetic classifies what it is looking at — geographic or not, dense or sparse — and picks the scan strategy from the data's own shape, the way an analyst sizes up an unfamiliar table before writing a query. An earlier version of this leaned on the specific quirks of one public dataset, and I tore it out, because an analyst that only works on the table it was demoed against is not an analyst.

For questions scoped to a named region rather than the whole planet, it filters by the region's actual boundary polygon — not a latitude/longitude box that leaks into the neighboring state — and fetches that boundary in two phases, extent first and geometry second, so drawing one polygon doesn't drag the whole boundary catalog through memory.

### Maps that are worth looking at

The geospatial answers needed to look like answers. Maps got a dark deck.gl basemap and a Turbo color ramp, size their points by rank, and fit the view to the data. A cluster of less glamorous fixes sits behind that: distances are computed in meters by projecting coordinates before the spatial index, not on raw lat/lon where a degree isn't a fixed distance; the map is guaranteed to include the actual winner, not a bare sample around it; and a WebGL race that could crash a map or pop the dev overlay got killed at its source.

### It no longer kills your analysis

Hermetic used to hard-stop every run at twenty minutes. But some questions honestly take longer — the same nearest-neighbor over California measured twelve minutes one run and fifty-six the next, and the cap was destroying the slow one every time, then calling it a failure.

So the timeout is gone, on every path and every source. In its place: a **Stop** button that actually kills the work when you decide it has gone on long enough; **live progress** that streams a steady heartbeat with elapsed time and the current phase, so even a silent forty-minute scan reads as progress rather than a hang; and an **up-front estimate** that tells you roughly what class of wait to expect without pretending to a fake countdown. The progress itself is now one clean, collapsible card — the current stage is the headline, and you can expand it to see the whole plan.

One honest gap I'll name rather than paper over: for a warehouse query, Stop cancels on our side immediately, but the query keeps running inside the warehouse until it finishes. True server-side cancellation is wired for next. The sandbox path — where the long local scans live — stops instantly.

### It remembers your schema

Connecting a big remote dataset means introspecting it, which can take a minute or two, and doing that again on every reconnect is pure waste. Hermetic now fingerprints a source from storage metadata it can read cheaply and reuses the schema when nothing has actually changed — checked, not assumed from the name. Because caching should never trap you on a stale picture, the connect dialog has a "don't use cache" option and the schema sidebar has a refresh button.

### Bring your own Claude — no API key

You can now point Hermetic at the `claude` command-line tool as its model provider. If you already have Claude Code installed and logged in, that is the entire setup: no key to paste, no console to visit. Hermetic shells out to `claude` and uses whatever login the CLI already holds — a Pro/Max subscription or API billing. It sits alongside the providers that were already there — Anthropic direct, Bedrock, Vertex, an OpenAI-compatible endpoint, and the local backends — so you pick it in Settings, or just leave `claude` on your PATH and it gets detected as a fallback when nothing else is configured.

The honest footnote is a cost one, in two parts, because I got it wrong twice. First I priced these calls at zero, reasoning that a subscription is flat — which is simply false for anyone metered per token, so it now reports the equivalent API cost instead. Then a user showed me a run that cost far more than the same work through the API, and the reason was almost funny: every single call was dragging about eighteen thousand tokens of the CLI's own tool definitions along with it — schemas for a file editor and a shell that the analysis never touches — and paying to cache that scaffolding on each new prompt. Hermetic runs its generated code in its own sandbox; it has no use for the CLI's tools. So it now tells `claude` to load none of them, which took the overhead on a call from roughly eighteen thousand tokens down to a hundred and fifty. The lesson is the one this project keeps relearning: measure the thing before you trust its bill.

## Trust: not showing you anything untrue

At planet scale the fastest way to be wrong is to quietly answer a global question from a local sample, so a long thread this month was making that impossible. `LIMIT` now caps only the _output_ of a query, never the input of a global computation. An aggregate computed over an unordered, limited sample is rejected outright. So is an O(n²) cross- or self-join over a large table. And when a query genuinely has to be bounded to less than the question asked, that scope is disclosed in the result instead of being smuggled past you. There was even a bug where, faced with 2.5 billion rows, the model would just _narrate_ — "With 2.5 billion buildings, one would expect…" — instead of computing; that now gets rejected as the non-answer it is.

Then, mid-month, I did something I had been putting off: a full, written review of the whole codebase, followed by a long series of fixes against it. The security-relevant ones: the remote-Parquet fetch refuses to be pointed at internal hosts (no SSRF), the local file browser is jailed to a root, SQL is enforced read-only at the connector itself rather than merely requested in a prompt, the sandbox's "no network" claim was made _actually_ true by gating Docker networking, and logs redact anything secret-shaped. Alongside those, real observability — a correlation id threading every log, cost row, and diagnostic for a run; per-phase stage durations — and a genuine test story, including a pre-push gate that runs the full suite (now well into four figures) and coverage on entry points that were sitting at zero. None of it demos. That is rather the point; trust is mostly things not happening.

The foundation under all of it is unchanged and is still the whole reason the project exists: the model writes the code, the code runs against your rows in your sandbox, and the model sees only schema and results.

## Reliability: keeping a long run alive to the end

Removing the timeout only helps if the run actually survives the wall clock, and a few things were quietly ending long runs for reasons that had nothing to do with the analysis.

The sharpest was your Mac going to sleep: on a long remote scan the machine would idle-sleep, its timers froze mid-run, and it surfaced as a baffling "network error." Hermetic now holds a wake lock while a scan or query is executing and lets go the moment it's done. A completed run is also no longer thrown away because you looked away — if the browser disconnects mid-run, the result is saved server-side and waiting for you.

And the one I'll admit with a wince: the moment I let analyses run long, three _other_ one-hour clocks I'd forgotten about started expiring people's data mid-session. The uploaded file, the warehouse connection, the cached results — each had its own fixed lifetime measured from when it was created, fine only because nothing used to run long enough to reach it. A long analysis followed by a follow-up would tip past the line and you'd be told to re-upload. They're now sliding idle windows — the clock resets every time you touch the data — and, more importantly, anything an in-flight run is using is pinned and can't be swept out from under it, however long the run takes. Removing one self-imposed limit is what exposed the others.

Two more long-run killers surfaced once the scans got genuinely big. The first was memory. A nearest-neighbor over a whole continent could balloon past what the sandbox container had, and the process would simply die — no answer, no useful error. So there is now a memory watchdog polling the container four times a second, an up-front feasibility check that refuses a plan it can already tell won't fit, DuckDB pinned to the container's real limit instead of optimistically assuming the host's, and the coarse-to-fine planet scan rewritten to _count_ its candidate cells rather than materialize the tail of them — which is the difference between reading a summary of the thing and reading the very thing you were trying to avoid reading. The second was closer to home: reload the page mid-run, or just let the dev server hot-reload under you, and the run was orphaned. Now it reconnects to whatever is still in flight, and the live progress picks up where it left off.

## What's next

June closed on the idea of budgets: now that a run can see what it spends, hand it a ceiling and let it pace itself. July built the harder prerequisite — a run that can also see its own clock, and that no longer dies at an arbitrary line. So the thread is finally ready to pull: giving an investigation a real budget of time and money for a question, and letting it weigh one more follow-up against what's left. An agent that can see both its clock and its bill can start to stop on its own terms, rather than mine or a timer's.

If you point Hermetic at something big — a cloud dataset, a spatial question over billions of rows — and it either surprised you by finishing or surprised you by how it got there, I'd genuinely like to hear about it.

Open source, local first. github.com/achalp/hermetic

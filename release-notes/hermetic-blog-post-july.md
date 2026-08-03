# Hermetic in July: bigger questions, and an analyst that learns your business

Hermetic is an open-source, local-first AI data analyst I've been building in public. Its founding constraint is unchanged: the model writes the analysis code, but it never sees your data. Since the June update, the work has centered on three themes: removing the practical limits on what you can ask, letting the tool absorb your team's knowledge, and making wrong answers harder to produce. There is also one change with quieter but possibly wider reach: you no longer need an API key to run it.

## Query data on S3 without becoming a data engineer

An enormous amount of useful data never reaches a warehouse. Open datasets like Overture Maps are published as Parquet files on S3, and companies park exports, event dumps, and lake tables in object storage the same way. That data can answer questions today, but only if someone first builds the machinery: provision a warehouse, write a pipeline, load the data, keep it fresh. The person with the question is rarely the person who can do all that.

Hermetic now skips the machinery. Give it an S3 or HTTPS address for a Parquet dataset and it analyzes the data where it sits, with nothing downloaded and nothing provisioned. To test the limits, I pointed it at Overture Maps' public catalog of roughly 2.5 billion buildings and asked which building on Earth is farthest from any other. The answer arrived in minutes, on a map.

That speed is not a sampling trick, and the method is not specific to maps. Hermetic approaches every large question the same way. It first reads the dataset's own summary statistics (Parquet files describe their contents) to learn how much data is in scope and where it sits. If that fits in memory, it runs one direct, exact pass and is done. If it doesn't, it works coarse to fine: the database summarizes and counts rather than reads, whole regions of the data that provably cannot contain the answer are discarded, and the exact computation runs only on the small set that survives. Raw data is touched only for the finalists. And on the rare occasion a computation must be narrowed to stay within budget, the answer says so plainly instead of presenting itself as complete.

The building question shows a domain building on that base. The generic pass mapped the entire planet from file statistics in about 24 seconds. Geographic knowledge then sharpened the search: the most isolated building must, by definition, sit in a near-empty area, so dense regions were eliminated by counting alone and only a small remainder needed the exact nearest-neighbor computation. The same layer knows that "California" means the state's real boundary, not a rectangle that overlaps Nevada. Notably, that geographic knowledge ships as a skill, the same mechanism described in the next section, rather than as special cases wired into the engine.

The practical effect is that the gap between wondering and knowing has collapsed, even at scales that used to require infrastructure.

## It learns your definitions

Every business defines things its own way. The fiscal year might start in February. An "active customer" might mean activity in the last 90 days, not every account ever created. Bookings, billings, and revenue might be three different numbers, and a renewal is not a new deal. A generic AI analyst knows none of this, so it produces fluent, well-formatted answers with the wrong denominators. The error surfaces in a meeting, not in the tool.

Hermetic can now be taught these rules. A skill is a small folder containing a markdown file that describes how a class of analysis should be done: which definitions apply, which mistakes to reject. It can also hold a few of your own tested Python functions for the analysis to call instead of re-deriving the math. Drop the folder in and it applies from the next question onward. Five worked examples ship with the product, so nobody has to start from a blank page.

That last part, bringing your own methods in Python, wasn't my idea. It came as an ask from a cohort of graduate students at the University of Chicago, who wanted analyses to run through the methods they already trusted rather than have a model re-derive them. It was the right request, and it shaped the feature.

What you get in return is consistency. A metric is computed the same way in March as it was in January, because the rule lives in a file rather than in someone's memory, and a correction made once doesn't need making again. Over time the folder becomes something genuinely valuable: your team's analytical knowledge in a form people can read, review, and version. Warehouse AI products address part of this with semantic models, which define your data and metrics. A skill carries the method as well: the checks, the refusals, and working code.

## Wrong answers get caught before they run

The failures that matter in a tool like this are rarely crashes, because a crash simply gets retried. The expensive failures are the quiet successes, code that runs cleanly and is subtly wrong: an average of averages, a total that includes what should have been excluded, a sample presented as the population. Those numbers land in your report looking exactly like correct ones.

So Hermetic now reviews code before running it. A second model reads the generated analysis against a set of correctness rules, the built-in ones plus whatever your skills contribute, and when it finds a violation the code is regenerated before any data is read. The review takes a few seconds, and the flawed version never reaches your data, your report, or your bill.

## Hard questions get the time they need

Until recently, Hermetic cut off every analysis at 20 minutes, which in practice meant the tool was deciding which questions deserved answers. Honest questions vary enormously in cost (the same statewide computation ran in 12 minutes on one occasion and 56 on another), and a fixed limit punishes exactly the questions that are hardest and most interesting.

The limit is gone. In its place you get visibility and control: the current phase and elapsed time stay on screen, a realistic estimate appears up front, and a stop button halts the actual computation, not just the display, the moment you decide it isn't worth more. Long runs also survive the ordinary hazards of a workday now. A laptop going to sleep no longer kills the analysis, reloading the browser reconnects to work still in flight, and a result that finishes after you've stepped away is saved and waiting when you return.

One admission from this work: several of the month's "memory failures" turned out to be my own cleanup process, which had lost track of active work and was quietly terminating it on a schedule. I fixed the memory more than once before finding the real cause. The lesson now runs through the project: verify that a failure is what it appears to be before engineering around it.

## The API key is no longer the price of entry

Tools like this all begin with the same speed bump: create a developer account, provision an API key, set up billing, keep the key somewhere safe. For a lot of people, analysts more than anyone, that step is where the trial ends. Yet many of the same people already pay for Claude and use it every day.

Hermetic can now run on that subscription. If the `claude` command-line tool is installed and signed in, that is the entire setup: Hermetic uses whatever login the tool already holds, and no key ever needs to exist. I suspect this becomes the most common way people run Hermetic, because it reduces getting started to a question most people can answer yes to: do you already use Claude?

Credit where it's due: this wasn't my idea. A colleague suggested it; I hadn't thought of it, and I took the implementation from there. It had one lesson in it worth passing on. The integration initially carried about 18,000 tokens of hidden overhead on every call, tool definitions Hermetic never uses. It now adds about 150, and the cost meter reflects what you actually pay.

## Follow-ups now retain their meaning

Follow-up questions against a warehouse had a subtle gap. Suppose you ask for second-quarter revenue excluding cancelled orders, then ask to see it by region. Until this release, the second query was written from that short sentence alone, so it could silently drop the exclusions and the time window you had just established: a correct-looking answer to a question you didn't ask. Follow-ups now inherit the previous question and its query, so a refinement stays a refinement: the same filters, the same period, your new breakdown. The conversation memory that makes this work still stores only structure, column names and shapes, never your values.

## Smaller refinements

A few smaller changes remove day-to-day friction. Reconnecting to a large dataset is immediate now, because schemas are remembered and verified rather than rebuilt. And the home page has been redesigned around the question itself: type what you want to know, attach the data (a file, a warehouse, a URL, or the built-in sample), and the analysis begins when the source is ready.

## The landscape, briefly

AI-assisted analysis became table stakes this year. Hex ships a notebook agent, Julius has grown into a platform, ChatGPT's agent mode delivers finished spreadsheets, and the warehouses themselves (Snowflake, Databricks, BigQuery) now answer natural-language questions directly. Power BI has Copilot throughout.

Hermetic makes a different set of choices. It is open source and runs on your machine, with a model you choose: a commercial API, a subscription you already hold, or a fully local model. Your data never reaches any of them. A CSV, a warehouse, and a public URL are all treated the same way. And among these tools it is the only one that takes your rules and enforces them rather than treating them as suggestions.

There is also an open-source tier, and it deserves its own mention because it lives in Hermetic's neighborhood: self-hosted, open code, your choice of model, including local ones. Wren AI is the strongest of these, a governed text-to-SQL product with a versioned semantic layer and mechanical validation of the queries it generates. The honest distinction is scope. Tools in this tier stay inside SQL, which bounds what an analysis can be; Hermetic runs full statistical Python under the same privacy posture, and its skills carry analysis methods, not just data semantics. The tier also has a sobering pattern. Vanna was archived this spring, Dataherald wound down, and PandasAI has gone quiet, each following the same arc: freeze the open code, sell the hosted cloud. Keeping the open, local version the actual product is a deliberate choice here, not a funnel. A detailed comparison of both tiers lives in the repository under `comparisons/`.

## What comes next

June's update closed on the idea of giving analyses a budget, and July removed the arbitrary limits that would have made budgets meaningless. The next step is to make the idea useful: an investigation that knows how much time and money it has left, and weighs whether another step is worth it. Skills, meanwhile, should become nearly effortless to author. Correcting a flawed analysis once should be enough to teach the tool.

If you point Hermetic at something ambitious, or teach it something it didn't know, I'd like to hear how it goes.

Open source, local first: github.com/achalp/hermetic

# The compiled path and output styles

How the compiled composer turns declared claims into a document, and what an output style changes. Moved out of the [README](../README.md#philosophy); the philosophy it implements is summarized there.

## The compiled path, block by block

The organizing idea: **one small LLM call decides what to say; everything that decides whether it's true is code.**

```
question ──► ANALYSIS (LLM writes Python)
                │  declare_finding / declare_check / declare_series
                ▼
          SANDBOX RUN (model never sees rows)
                │  envelope: claims + regimes + series + results
                ▼
          PLAN CALL (the one narrative LLM call)
                │  sees projections only — names, definitions, field names
                ▼
          COMPILER (deterministic)
                │  templates + riders + charts + caveats, all $finding: bindings
                ▼
          FINALIZER / RESOLVER (deterministic)
                │  bindings → real values, units, shapes rendered as prose
                ▼
          POST-RENDER INVARIANTS ──► document / persist / edit
```

**Block 1 — The analysis declares claims.** Code generation produces a Python script that doesn't just compute — it _declares_. `declare_finding` records each claim with a name, typed value, and plain-language definition, right beside the computation. The statistical judgment inside those helpers isn't the model's: the runtime (`docker/sandbox/hermetic_runtime`) profiles every series — zero inflation, heavy tails, thin edges — and the regime matrix dispatches: Kruskal–Wallis under heavy tails, count-weighted trends, sentinel-zero exclusion for money. A helper that looked and found nothing says so in the value (`"detected": false`). The envelope that leaves the sandbox is the whole truth the rest of the pipeline is allowed to use.

**Block 2 — The projection decides what the narrative model may see.** `src/lib/findings/project.ts` strips every value, keeping names, definitions (numeral-scrubbed), and _field names_ — minus booleans (a flag has no word for a sentence slot) and minus everything on a non-detection (nothing left to misuse). This is the privacy boundary and the truthfulness boundary in one: the planner can't leak values it never had, and can't fabricate around numbers it was never offered.

**Block 3 — One LLM call writes the plan.** `src/lib/compose/planner.ts` sends the question, the projections, and the shipped chart ids, and gets back a typed program: ANSWER / TREND / EXPLAIN / CAVEAT / INSIGHT / METHOD / CONCLUSION nodes, each with refs and authored prose in which **every figure must be a `$finding:` binding** — a literal digit is a validation error. `plan.ts` validates structurally: exactly one ANSWER, every ref resolves, CAVEATs may only reference checks, boolean bindings rejected. A failed node degrades individually (salvage); only total wreckage falls back to the deterministic default plan. This is the quarantine: the model's generative act is ~10 nodes of prose with holes where the numbers go.

**Block 4 — The compiler builds the document, no LLM.** `src/lib/compose/compile.ts` walks the plan: failed-check banner first, headline tiles, one element per node with stable ids (so edits survive re-runs), charts derived from the declared series' roles, anchored under their EXPLAINs, filters wired from declared aggregation recipes. `realizer.ts` supplies text where the planner didn't — and appends **riders** to text where it did: catch-all disclosure, relaxed attestation bar, excluded-trailing, thin-groups, zero-screen. Authored prose can replace a template's headline sentence; it cannot suppress a disclosure.

**Block 5 — Resolution makes the numbers real.** The document so far contains no data — just bindings. The finalizer (`src/lib/llm/resolve-placeholders.ts`) substitutes each `$finding:` against the envelope: currency gets 2dp and separators, units attach by declared identity, and non-scalar values go through the value renderer — intervals as "−11.15 to 11.51", mappings ranked with the minimum named. A genuinely unspeakable value drops its token, never its sentence. This is the same resolution stack generative mode uses, so there is exactly one path to trust.

**Block 6 — Invariants, then the record.** After finalization, the pipeline re-checks the rendered document: any plan node that resolved empty degrades to its deterministic template; an ANSWER empty even then is a recorded structural failure — the document never ships answer-less. The grounding verifier counts declared-vs-cited claims and untraceable figures into the Verify panel; an on-demand adversarial audit reads the whole thing back. Then everything persists — spec, plan, code, envelope — which is why edits recompile the same plan instead of re-asking the model, and why a restore replays the identical document.

The failure philosophy stitching the blocks together: each one makes a class of lie _unrepresentable_ rather than detected — no rows in the model's context (1), no numbers in the planner's hands (2), no syntax for a fabricated caveat (3), no suppressible disclosure (4), no unformatted or dangling value (5), no empty answer (6). The defects that do slip through live at the _seams between blocks_ — a projection offering the wrong field, a resolver refusing a speakable value — which is why the audit trail (`specs/`) keeps landing fixes at boundaries rather than inside any single block.

## Output styles — what a purpose changes (and what it doesn't)

Every analysis is composed for one of four **consumption contexts**, and the same run can be composed by either the generative or the compiled path. A purpose is defined by _how it's read_, which fixes the narration/summarization style and a cost/latency envelope — **not** by chart count, and **never** by how rigorously anything is analyzed.

Three levers, decoupled:

- **Rigor is flat.** A brief's one-line verdict is as well-tested as a deep-dive's. Every style computes the same Computed-Findings battery (trend significance, step-change scan, base-effect flag) and the same **rigor floor** — decompose the headline change into its parts, and compute the constituents of any ratio the answer names — regardless of how briefly it's shown.
- **Breadth scales, and it's the _only_ analysis lever that does.** More sub-questions cost real money (each ≈ one SQL-gen + code-gen + sandbox run), and a 30-second-read brief should also _generate_ fast — so breadth tracks the context's patience, not the reader's deserved rigor.
- **Presentation is a guardrail, not a definition.** Charts are cheap now (deterministic on the compiled path), so hiding analysis you already ran is user-hostile. Density is governed by the **narration frame** (compiled `maxNodes`; the generative prompt), and the chart/tile caps are generous ceilings, not the thing that makes a brief a brief.

| Lever                                                | brief | dashboard | report | deep-dive |
| ---------------------------------------------------- | ----- | --------- | ------ | --------- |
| **Rigor floor** (battery + decompose + constituents) | ✓     | ✓         | ✓      | ✓         |
| **Breadth** — `maxSubQuestions` (cost/latency)       | 2     | 3         | 4      | 10        |
| **Narration** — `maxNodes` (the succinctness lever)  | 7     | 12        | 22     | 28        |
| **View cap** — `maxViews` (relaxed guardrail)        | 3     | 6         | 10     | 16        |
| **Headline tiles** — `maxTilesFor`                   | 3     | 5         | 4      | 5         |

**What keeps rigor flat** is two purpose-independent floors: a _prompt_ floor (the Computed-Findings battery + rigor-floor clause, carried in every style's code-gen scope) and a _deterministic_ floor (`result-validator.ts` and a battery of findings lints — trend-contract, check-gating, null-ancestry, definition-consistency, and more — that run on every manifest with no purpose branch). A claim can't be asserted without its evidence no matter which style asked for it. The purpose only decides how much of what was found gets narrated, and across how many angles it was worth exploring.

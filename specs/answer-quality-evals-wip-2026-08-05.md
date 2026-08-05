# Answer-quality evals — WIP / TODO

> Created: 2026-08-05
> Status: TODO — parked by decision after a design chat; enterprise-relevant
> (both audited competitors now ship eval stories: Hex "Evals" 2026-08-04,
> Wren's text-to-SQL eval framework). Pick up when prioritized.
> Origin: the gap every recent doc names — Vanna audit rec #1,
> open-gap lines in all three 2026-08-05 comparisons.

## The distinction that frames the work

Hermetic has **verification** (per-run gates: grounding/verify_narrative,
pre-execution code review, result-validator) and **regression pinning**
(golden transcripts — byte-identical under replay, so they break on ANY
variation). It has no **evaluation**: across a corpus of questions, how
often is the analysis right, and did this week's prompt/model change move
that number? Evals must tolerate variation and score correctness — the
opposite contract from golden transcripts. They cannot run under replay
(generation quality is the measurand): live-LLM, costed, nightly/
pre-release, not per-push.

## TODO

- [ ] **Corpus, tiered** (correct is underdetermined for open questions):
  - [ ] Factoid tier — one right number; exact/tolerance match.
  - [ ] Analytic tier — rubric + grounded judge (below).
  - [ ] Exploratory tier — method/structure checks only; no correctness claim.
- [ ] **Ground truth without labeling labor**:
  - [ ] Synthetic datasets with planted facts (generator knows the answers;
        plant the review-gate trap catalog: avg-of-avgs bait, mixed grain,
        must-exclude rows; plus realistic mess — nulls, encoding junk,
        duplicate keys).
  - [ ] Metamorphic invariants (label-free): row-shuffle ⇒ identical;
        column-rename ⇒ identical; unit ×1000 ⇒ scaled; pre-filtered CSV vs
        filter-in-question ⇒ identical.
  - [ ] Cross-engine agreement: same question via warehouse SQL path vs
        pandas path ⇒ same numbers.
  - [ ] Small hand-verified real-data set for credibility (keep small).
- [ ] **Grounded judge** — no free-reading LLM-as-judge: the judge must
      trace every scored claim to the run's computed artifacts
      (verify_narrative + rubric). This is the differentiator vs Hex
      (scores user agents, cloud) and Wren (SQL validity only): full
      analyses — SQL + Python + narrative faithfulness.
- [ ] **Runner**: n-trial (n≈3) score distributions, not single-shot;
      budgeted (≈50 q × 3 × ~$0.35 ≈ $50/run; claude-cli transport can
      absorb on subscription); nightly or pre-release trigger.
- [ ] **Reporting**: results dashboard IS a hermetic dashboard (dogfood);
      regression deltas on /diagnostics beside the failure-mode ranking.
- [ ] **Skills loop tie-in**: every correction that produces a skill also
      produces an eval case — teach → enforce (review gate) → measure
      (eval). Closes the loop no competitor has.
- [ ] **Risks to design against**: prompt-overfitting to a stable corpus
      (metamorphic checks resist this better than fixed Q&A); synthetic
      drift from real-data messiness; judge-model version pinning.

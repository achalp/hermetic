# Grounded narrative: truthful stories from a values-blind composer

**Date:** 2026-08-06 · **Status:** v1 shipped (see §4) · **Owner seam:** code-gen
prompts (`lib/llm/prompts.ts`), compose prompts (`lib/pipeline/dashboard-compose.ts`,
`lib/llm/prompt-fragments.ts`), grounding (`lib/pipeline/grounding.ts`).

## 1. The problem, from a real run

Run `b54cff76` (history `c411967f`, "What is the churn rate, and how has it
changed over the year?", purpose=dashboard, metadata mode):

- The sandbox computed `mom_change_pct` showing a +4.4pt August step against a
  ±0.2 baseline — and the narrative described a smooth upward year. The step
  change was in the data, not in the story.
- A sibling run narrated "churn rate rising every month" beside its own
  computed `churn_rate_trend_rising: false`.
- A StatCard labeled "YTD Change 8.73" with `format: percent` for a
  percentage-POINT quantity, seeded by a result key misnamed `_pct`.
- No mix-vs-rate decomposition and no base-effect flag — the two questions an
  exec asks first — because the code never computed them.

Root cause is structural, not a bad model day: **in metadata mode the composer
sees no values** — result schemas, chart shapes, placeholder rules. Every
number it "states" is a placeholder bound later; every direction word it
writes is a guess, anchored (by next-token gravity) to the question's framing.
That is the privacy USP working as designed — the fix must NOT be "show the
composer the data."

## 2. Design principles

1. **The narrative layer may only STATE what the analysis layer COMPUTED.**
   Findings are results entries, not reader inferences. If the story should
   mention a discontinuity, the code must emit the discontinuity.
2. **Claims are bound, not asserted.** Numbers via `$result:` placeholders
   (inline-in-prose resolution already exists — resolve-placeholders pass 2).
   Direction words are themselves bindable: a result key holding the STRING
   `"rising" | "falling" | "flat"`, referenced inline, renders the computed
   word without the LLM ever seeing it. Conditional phrasing uses the spec
   renderer's existing `$cond/$then/$else`.
3. **Enforcement is mechanical, advisory, low-false-positive.** Prompts steer;
   the grounding pass verifies. Same posture as numeric grounding: never
   block, surface a caveat, log for the learning loop.
4. **Purpose scales rigor, not just breadth.** The findings battery is cheap
   pandas — every purpose computes it. Deep-dive adds decomposition and
   per-segment tests; dashboard stays visually focused but never
   analytically shallow.

## 3. The contract

**Code-gen (Computed Findings, all purposes):** for change/rate/comparison
questions, emit:

| Finding              | Result keys                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Trend                | `<metric>_trend_direction` ("rising"\|"falling"\|"flat", OLS + p≥0.05→flat), `<metric>_slope_per_period`, `<metric>_trend_p_value` |
| Step change          | `<metric>_step_change_period` (label or None at ~3σ of period-delta spread), `<metric>_step_change_delta`                          |
| Base effect (ratios) | denominator trend + `<metric>_base_effect` ("masking"\|"amplifying"\|"none")                                                       |
| Superlatives         | `peak_*` / `top_*` keys; monotonicity flag instead of tautological extremes                                                        |

Units in names: `_pp` for percentage points, `_pct` for percentages — the UI
formats and labels from the name.

Deep-dive adds the general obligations, applied per the question's shape —
DECOMPOSE headline changes into parts, test HETEROGENEITY across groups,
test ROBUSTNESS (discontinuities, outliers, period sensitivity), examine
CONSTITUENTS of ratios/composites separately. (Mix-vs-rate decomposition and
per-segment slope tests are the churn-question instances, not the contract.)
Report adds per-group comparisons with significance on the gap.

Altitude rule: base prompts carry PRINCIPLES with examples marked as
examples; named, domain-specific procedures belong in SKILLS (tested helpers)
and the exemplar bank, which are teachable and empirically grown — not
hardcoded into the contract where they'd bias every unrelated question.

**Compose (Narrative Grounding rules, injected in both schema modes):**
numbers only via `$result:`; direction words bound inline from
`*_trend_direction` keys or gated with `$cond`; superlatives only via
`peak_*`/`top_*` keys; the question's phrasing is not evidence — when the
question presumes a direction, bind the computed verdict and let it disagree.

**Enforcement (grounding.ts):** beside the numeric trace, a directional check:
narrative direction (negation-aware, silent when a text asserts both
directions) vs. the results' unanimous trend verdict (boolean `*rising*`-style
keys and string `*trend*`/`*direction*` keys vote; disagreement or "flat" →
silence). A contradiction sets `contradictions` on the GroundingReport and
fails `ok`, surfacing through the same `__grounding` state channel and caveat
UI as untraceable figures.

## 4. Shipped in v1 (2026-08-06)

- Purpose `codegenScope` upgrades (all four modes) + shared Computed Findings
  contract block in the code-gen system prompt.
- `NARRATIVE_GROUNDING_RULES` fragment, injected into the single-shot compose
  prompt (metadata AND values modes).
- Directional-contradiction check in `verifyGrounding` (opt-in `results` arg),
  wired into the single-shot compose grounding pass; `contradictions?` added
  to the GroundingReport contract.

## 5. Roadmap (not yet built)

- **Findings — SUPERSEDED by `specs/declared-findings-2026-08-06.md`** (the
  fixed-taxonomy validator was rejected as a point-in-time corpus that caps
  the model's analytical vocabulary; the declared-measures architecture keeps
  the guarantees as a content-free grammar). Original rationale kept below
  for the record:\*\*
  across two runs on identical data the heterogeneity keys changed SHAPE
  (`segment_heterogeneity_significant: true` + ANOVA → a test-free
  `_verdict: "consistent"` string) and flipped conclusion — prompt-level
  "use exactly these names" (added same day) mitigates, but only a typed
  `findings` list from `write_output` (kind/metric/fields), validated
  server-side, makes the results schema a CONTRACT downstream consumers can
  rely on. Same run also narrated a base-effect flag against its own
  decomposition (86.6% rate-driven) — the coherence rules (base_effect
  derived from decomposition; attribution follows the dominant term) are now
  in the prompts, but the validator is where they become guarantees.
- **$cond-driven template blocks:** a NarrativeBlock component that renders a
  finding descriptor with renderer-owned phrasing per kind — removes even the
  sentence-structure guesswork for the highest-stakes claims.
- **Contradiction → auto-caveat rendering:** today the report reaches state;
  render an explicit inline caveat chip on the offending TextBlock.
- **Investigate parity:** inject the grounding rules + directional check into
  the investigate composer path (currently numeric-only there).
- **Sandbox helpers:** preloaded `findings.py` (changepoint, decomposition,
  slope tests) so code-gen calls helpers instead of re-deriving statistics.
- **Learning-loop closure:** contradiction events already land in the failure
  log; feed them to the exemplar bank as negative examples.

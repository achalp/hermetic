---
name: ab-experiment
description: A/B experiment readouts — per-variant rates with significance and uncertainty, never bare point estimates
order: 210
triggers:
  columns: ["^(variant|treatment|experiment|arm|test_group|bucket)$"]
  question:
    ["a/b", "ab test", "experiment", "variant", "statistically significant", "conversion lift"]
reviewRules: |
  EXP-SIGNIF — flag when per-variant conversion rates / means are compared, ranked, or declared a "winner" WITHOUT any significance or uncertainty computation (use skill_lib.ab_experiment.two_proportion_ztest / lift_ci — a 2% lift on 300 users is noise presented as signal).
---

## Guidance

Experiment/variant questions on {{filename}}:

- Report per-variant: n (denominator), conversions/successes, rate — and a
  SIGNIFICANCE readout (p-value from the preloaded two_proportion_ztest) plus
  a CONFIDENCE INTERVAL on the lift (lift_ci). A bare "B is 2% better" is not
  an answer; "B +2.1% (95% CI −0.4%..+4.6%, p=0.09, n=1,540/1,538)" is.
- DENOMINATORS: one unit per user/session as the experiment assigned them —
  COUNT(DISTINCT unit), never event rows (double-counting inflates n and
  fakes significance).
- Segment cuts (by device, region, ...) multiply comparisons — say explicitly
  that per-segment p-values are exploratory, and never present the single
  best segment as the headline (that is p-hacking by construction).
- results["analysis_scope"] states the unit, the date window, and any
  excluded traffic (bots, incomplete assignments).

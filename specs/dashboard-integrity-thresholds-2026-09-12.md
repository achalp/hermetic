# Dashboard-integrity thresholds — a DECISION, not a validated design

**Status: provisional. Read this before changing, defending, or citing any number below.**

Everything in `lib/compose/series-scale.ts` and `lib/pipeline/data-sanity.ts` was
derived on 2026-09-12 from **a single exported dashboard** — a King County
housing-distress / homelessness / vacancy correlation (run `887d2bda`, history
entry `28b4a6ed`). The mechanisms were reasoned about; the constants were not
tuned against a corpus, measured against user outcomes, or validated on any
second dashboard.

They are in the codebase because shipping a defensible judgement beats shipping
nothing while a corpus is assembled. That is the whole justification. Nobody has
established that these are the right numbers.

## What is a decision, not a finding

| Constant                  | Value | Where                | Basis                                                                                                 |
| ------------------------- | ----- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `SCALE_RATIO_LIMIT`       | 10×   | `series-scale.ts`    | "roughly where a smaller series stops being legible" — an eyeball judgement on one chart              |
| `GROUP_SPAN_LIMIT`        | 4×    | `series-scale.ts`    | "the smallest series still occupies a quarter of the axis" — reasoned, never measured against readers |
| `SPIKE_DEVIATION`         | 0.4   | `data-sanity.ts`     | chosen so the observed 2021 collapse (−55% vs neighbours) clears it with margin                       |
| `NEIGHBOUR_AGREEMENT`     | 0.3   | `data-sanity.ts`     | chosen to separate a spike from a step on the one series examined                                     |
| `FLAT_CONTRADICTION_MOVE` | 0.2   | `data-sanity.ts`     | a round number; the observed case moved 0.55, so anything below ~0.5 would have caught it             |
| `P_SIGNIFICANT`           | 0.05  | `data-sanity.ts`     | convention, and the only constant here with an outside justification                                  |
| `IDENTITY_R`              | 0.999 | `data-sanity.ts`     | float-noise margin below 1.0; the only other constant that is close to principled                     |
| 5-row minimum             | —     | `findSeriesOutliers` | "too short for a local pattern to exist" — asserted, not derived                                      |

## The behaviour that is more invasive than it looks

`lintSeriesScale` **rewrites charts the composer produced**: three scales become
three charts, two become a `DualAxisChart`. Earlier lints in this codebase only
repaired things that were already broken (a dangling child id, an object in a
value slot). This one overrides a composition decision that rendered fine as
JSON and merely read badly.

That is a bigger claim to correctness than the constants currently support. A
chart that a reader found acceptable can be split by a threshold nobody
validated.

## What would turn this into a design

In rough order of value:

1. **A corpus.** Run the lints in report-only mode over the existing
   `data/history` entries and count how many charts would be rewritten. A high
   rate means the thresholds are too eager, or that multi-scale charts are common
   and acceptable in practice.
2. **A held-out check.** Confirm on a dashboard _other than_ the King County one
   that a rewrite improves it. Every test in this change uses numbers from that
   single run — which makes them faithful regressions and weak evidence of
   generality.
3. **Reader signal.** Nothing here has been put in front of anyone. "A quarter of
   the axis is legible" is an assertion about human perception made without
   consulting a human.
4. **Golden-transcript exposure.** The data-sanity caveats add text to the
   grounding channel, so a golden run containing an outlier or a near-identity
   correlation will shift. If goldens move after this ships, that is signal about
   how often these fire, not merely a re-record chore.

## Rules for future sessions

- **Do not cite these numbers as established.** They carry exactly as much
  authority as one afternoon's reading of one PDF.
- **Do not "fix" a threshold to make a specific dashboard look right** without
  checking what the change does to the corpus in (1). That is how a judgement
  call calcifies into folklore.
- **Do change them** when evidence arrives. That is the point of writing this
  down rather than leaving the constants looking self-evident.
- The **mechanisms** are better supported than the constants. Judging outliers
  against neighbours rather than the series median, splitting when no two-axis
  form is honest, deriving correlation-magnitude inconsistency from a detected
  identity — each of those corrected a first version that was wrong in a way the
  data exposed, and each is defensible independent of where the cut-offs sit.

## Provenance

Findings enumerated from `Draw_any_correlation_between_housing_distress__homelessness_.pdf`,
exported from the run above. The nine issues, the reasoning, and the two first
drafts that had to be corrected (median-based outlier detection flagging a rising
series' endpoint; a widest-gap axis split that still flattened a series) are in
PR #234 and its commits.

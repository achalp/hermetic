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

| Constant                    | Value | Where                | Basis                                                                                                 |
| --------------------------- | ----- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `SCALE_RATIO_LIMIT`         | 10×   | `series-scale.ts`    | "roughly where a smaller series stops being legible" — an eyeball judgement on one chart              |
| `GROUP_SPAN_LIMIT`          | 4×    | `series-scale.ts`    | "the smallest series still occupies a quarter of the axis" — reasoned, never measured against readers |
| `SPIKE_DEVIATION`           | 0.4   | `data-sanity.ts`     | a FLOOR only; the real test is `SPIKE_VOLATILITY_MULTIPLE` below                                      |
| `SPIKE_VOLATILITY_MULTIPLE` | 3×    | `data-sanity.ts`     | **has one piece of held-out evidence** — see "What CI already told us"                                |
| `NEIGHBOUR_AGREEMENT`       | 0.3   | `data-sanity.ts`     | chosen to separate a spike from a step on the one series examined                                     |
| `FLAT_CONTRADICTION_MOVE`   | 0.2   | `data-sanity.ts`     | a round number; the observed case moved 0.55, so anything below ~0.5 would have caught it             |
| `P_SIGNIFICANT`             | 0.05  | `data-sanity.ts`     | convention, and the only constant here with an outside justification                                  |
| `IDENTITY_R`                | 0.999 | `data-sanity.ts`     | float-noise margin below 1.0; the only other constant that is close to principled                     |
| 5-row minimum               | —     | `findSeriesOutliers` | "too short for a local pattern to exist" — asserted, not derived                                      |

## The behaviour that is more invasive than it looks

`lintSeriesScale` **rewrites charts the composer produced**: three scales become
three charts, two become a `DualAxisChart`. Earlier lints in this codebase only
repaired things that were already broken (a dangling child id, an object in a
value slot). This one overrides a composition decision that rendered fine as
JSON and merely read badly.

That is a bigger claim to correctness than the constants currently support. A
chart that a reader found acceptable can be split by a threshold nobody
validated.

## What CI already told us

The first version of the outlier check used a flat 40% deviation. The **golden
transcripts caught it immediately**: it fired on `expansion_mrr_delta` in the
ask-followup journey (41% below its neighbours at 2024-07). A monthly MRR delta
swings like that routinely — that is what a delta is — while the King County
series moves ~5-10% a year, so its 55% collapse is many times anything it
normally does. Same absolute deviation, opposite meanings.

So the test is now relative to each series' own habitual step (median relative
change between consecutive points, **trimmed** of the two largest, since a spike
contributes two enormous steps and would otherwise raise the bar past itself).

That was not enough on its own. The real series —
`2800, 2100, 2400, 2100, 1800, 1100, 1900, 1600, 1800, 1600, 1800` — still fired,
by **0.8%**: deviation 0.405 against a bar of 0.402. A rule that decides a coin
flip is not discriminating, and this was **one of three golden journeys**, so the
firing rate implied a caveat on a large share of real dashboards. A caveat that
common is wallpaper.

Hence `SPIKE_CONFIDENCE_MARGIN`: the evidence must clear the bar with room. King
County's collapse clears it by 3.4x; the MRR dip by 0.8%. This is close enough to
"tuning until the golden passes" to be worth defending explicitly — the rule is
_do not speak unless the evidence is unambiguous_, applied uniformly, and the
justification is the firing RATE, which is data.

A third lesson, at my own expense: I first modelled that MRR series by GUESSING
its shape and wrote a passing test against the guess. It passed and the golden
still failed. The fixture had the real numbers all along.

This is the only held-out evidence any constant here has, and it arrived by
accident rather than by the corpus pass below. Two lessons worth keeping:

- The golden suite is a usable corpus for checks like these. A failing golden
  after a change of this kind is DATA about how often a check fires, not merely
  a re-record chore.
- The first draft of every check in this change was wrong in a way only real
  data exposed: median-based outlier detection flagged a rising series' endpoint,
  a widest-gap axis split still flattened a series, and a flat percentage fired
  on ordinary volatility. Treat a new threshold here as wrong until data says
  otherwise.

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

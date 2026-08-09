# The Regime Matrix: statistical validity as a total, inspectable function

**Status: spec + reviews 2026-08-09; implementation same day. Companion to
claims-api (which it completes) and analysis-product (whose roles make it
self-wiring). Validated in advance by an in-memory simulation over run
92480eac's actuals (scratchpad/simulate-claims-compiler.py): the simulated
dispatch independently reproduced the post-fix production values (attested
peak 1998/$10/n=731, walk-back 10, reason=attestation).**

## 0. Diagnosis

Every statistical failure on record is a correct statistic misused under a
data regime its method didn't fit — never a missing implementation. The
judgment ("is zero a sentinel here? is the mean valid? is this year thin?")
lives in contract prose the model re-derives per run, which is why the zero
decision FLIPPED between two identical runs. The universe of _validity
conditions_ is enumerable — every stats text lists each test family's
assumptions — so the judgment can be closed in code:

**claims × regimes, with a deterministic response per cell.**

## 1. The three enumerations

**Claim types (bounded, ~12)** — trend, step_change, comparison (split/yoy),
superlative, current_state, outliers/screen, correlation, distribution,
share, decompose, heterogeneity, check. The boundedness argument: these are
the grammar of analytical assertion (level, change, extremum, composition,
association, dispersion, position-in-time); new types require a spec
amendment, same posture as series role kinds.

**Regimes (bounded, ~12)** — each with a deterministic diagnostic computed
from the data:

| Regime          | Diagnostic                                                  | Threshold  |
| --------------- | ----------------------------------------------------------- | ---------- |
| ZERO_INFLATED   | zero share of a measure                                     | > 5%       |
| HEAVY_TAIL      | moment skewness                                             | > 2        |
| CONTAMINATED    | max/median tail ratio                                       | > 50       |
| COUNT_SKEWED    | count mean/median dispersion                                | > 3        |
| THIN_PERIODS    | periods under the attestation bar (max(5, .2·med, .1·mean)) | any        |
| THIN_EDGE       | trailing run of thin periods                                | > 0        |
| SHORT_SERIES    | n_periods                                                   | < 8        |
| DISCRETE        | distinct-value share                                        | < 10%      |
| TIED            | modal-value share                                           | > 30%      |
| NEGATIVE_VALUED | negative share                                              | > 0        |
| NON_MONOTONE_X  | x not strictly increasing                                   | bool       |
| MONETARY        | declared unit is a currency                                 | from roles |

**Responses (three kinds)** — per cell: _method dispatch_ (median not mean;
Spearman not Pearson), _degrade with the violated regime named_, or _attach
a machine caveat field_. Never silent.

## 2. The artifact: `hermetic_runtime/regimes.py`

- `profile_regimes(values, counts=None, labels=None, unit=None) -> dict` —
  all diagnostics + fired flags. Pure, never-raise, ~O(n).
- `REGIME_MATRIX: {claim_type: {regime: response_description}}` — the
  machine-readable matrix. THE completeness artifact: every cell is
  implemented or explicitly `None` (not applicable, with the reasoning in
  the table itself). A meta-test asserts (a) every matrix regime has a
  diagnostic key in the profile, (b) every claim type in the findings
  library appears as a matrix row — empty cells are found by INSPECTION,
  not by runs.
- Dispatch helpers the claim functions and generated code call:
  `select_center(profile)` ("median"|"mean" + reason),
  `zero_policy(profile)` ("sentinel_exclude"|"keep" + reason — the rule
  that flipped between runs becomes one function),
  `attestation_bar` (already shared).
- **Self-wiring**: `write_output` profiles every declared series that
  carries a count/measure role (values from the measure column, counts from
  the count role) and ships `regimes[series_id]` in the envelope. The model
  never passes what the roles already declare.

## 3. Cascade

- **Claim functions**: already carry proto-diagnostics (degenerate gates,
  attestation, coverage); they now share the profiler's primitives. No
  return-shape changes beyond what shipped this week.
- **Envelope/host**: `regimes` rides the envelope (raw, like findings);
  parse-output passes it through; artifacts cache/history persist it; the
  composer (spec 2) and the audit receive WHY methods were chosen.
- **Contract**: shrinks — ZERO SENTINEL, SKEWED MONEY, attestation prose
  become "call the dispatcher" references. (Deletion deferred one
  generation: teach both, then cut, same pattern as prior consolidations.)
- **MCP**: profile visible via the envelope in artifacts; a
  `profile_regimes` MCP tool is NOT added (the profile is per-series data,
  already in artifacts) — spec 2 adds the tools where interaction lives.

## 4. Principal-engineer review

1. **Threshold brittleness** — thresholds (5%, 2, 50, 3) are matrix DATA,
   not scattered constants; each cites its motivating run in the table.
   Changing one is a one-line diff with a visible blast radius.
2. **Double computation drift** — claim functions computing their own gates
   vs the profiler: converged on shared primitives (`_attestation_bar` is
   already the single source); the meta-test pins that the profile's bar
   equals the claims' bar on the same input.
3. **Never-raise discipline** — profiler failure degrades to `{}` +
   `flags: []`; a profiling bug must not kill an analysis (repo invariant).
4. **Envelope growth** — profile is O(#series × #diagnostics) scalars,
   trivial; no rows duplicated.
5. **Fallback prelude** — stub returns `{}`; degraded deploys lose regime
   flags, never NameError (getter-exposure lesson applied).

## 5. Principal-data-scientist review

1. **Moment skewness on small n is noisy** — acceptable: it gates a
   _caveat/dispatch_, not a hypothesis test; SHORT_SERIES fires alongside
   and dampens (matrix cells for SHORT_SERIES override tail dispatches to
   "report, don't decide").
2. **The 5% zero bar** — a zero-inflated measure at 4.9% slips through;
   mitigation: the zero_policy response reports the share REGARDLESS, so
   the composer/audit see near-threshold cases; the threshold gates only
   the automatic exclusion.
3. **Attestation bar** — the median+mean-floor formula survived one
   over-correction cycle (weighted median rejected by audit); the DS review
   endorses it with the documented property: balanced ⇒ median term binds;
   heavy-tailed ⇒ floor tracks mass-per-period. Sensitivity: the sim
   corpus lands bar≈635 (vs 178 too-lax / 11,297 too-strict).
4. **MONETARY from roles** — unit strings are open vocabulary; currency
   detection is a conservative allowlist (usd/eur/gbp/$/€/£/dm/...); a miss
   degrades to "no MONETARY flag", never a wrong exclusion.
5. **What stays with the model** — WHICH claims to make about WHICH
   columns. The matrix closes how, not what. Correct division.

## 6. Test plan

Unit tests per diagnostic (boundary values), matrix meta-test
(completeness), profiler↔claims bar equality, envelope integration
(declared series ⇒ regimes shipped), prelude parity.

## 7. Amendment (2026-08-09): claim-layer totalization

The first compiled run showed the dispatcher alone is ADVISORY: the model
declared a blocking zero-sentinel check citing `zero_policy`, reported
`n_excluded=0`, and left 12 $0.00 year-rows in every downstream figure.
A policy the model must both _call_ and _apply_ is a convention, not a
contract. Closed by threading `unit=` through the claim functions —
the same move that made attestation total via `counts=`:

- `finding_trend`, `finding_superlative`, `finding_current_state`,
  `finding_split_comparison`, `finding_outliers`, `finding_distribution`
  accept `unit=`. Each runs `profile_regimes` + `zero_policy` internally
  (`_zero_screen` in findings.py); under `sentinel_exclude` zeros become
  None before the statistic and the count ships as `n_zero_excluded`
  (additive return key; None in failure shapes, stub parity included).
- The realizer renders the screen whenever `n_zero_excluded > 0` — an
  applied policy the reader can't see is the same defect as an unapplied
  one.
- Contract: "ALWAYS pass unit= for monetary measures"; a check's
  record-level `n_excluded` must agree with the helpers' figure.

**The boundary.** The CLAIM layer is total: pass the unit and the policy
cannot not-run. The RECORD layer (the model's dataframes, chart series,
rollups) stays lint- and contract-guarded (`zero_sentinel_unapplied`,
CHECKS ACT OR FAIL) — the runtime never sees pre-aggregation rows, and
the platform must not silently rewrite series data the reader will chart.
Gates decide emphasis and computation, never visibility: excluded zeros
are always countable in the payload, and the record-level exclusion
remains a declared, checkable action of the generated code.

## 8. Amendment (2026-08-09): full closure — all twelve helpers, all 144 cells

Auditing "is the six-function set exhaustive?" answered itself: it wasn't,
and the matrix couldn't say so — only the `trend` row carried a
ZERO_INFLATED cell, and a sparse row is ambiguous between "addressed
elsewhere" and "never audited". Two changes:

**Four more helpers threaded.** `finding_step_change` (a trailing $0.00
sentinel passes all three step gates and `counts=` cannot save it — a
proven phantom regime change, now the motivating test),
`finding_heterogeneity` (pooled policy decision, applied per group — one
policy per measure, never per group), `finding_yoy` (zeros are
sum-neutral but window-relevant: an all-sentinel month drops from BOTH
overlap windows), and `finding_correlation` (per-axis `x_unit=`/`y_unit=`;
a screened member drops its pair). `finding_share` and
`finding_decompose` are decided N/A, recorded in their matrix cells: a
zero part/term genuinely contributes nothing to a sum, which is exactly
what the sentinel means there.

**The matrix is closed.** Every row now carries every regime key; each
cell is a response string — tagged (implemented) / (upstream) / (caveat)
/ (accepted) — or an explicit None for deliberate N/A. The meta-test
asserts full closure (row key-sets equal the profiler's flag vocabulary)
and pins the ZERO_INFLATED "(implemented)" cells to exactly the claim
types whose functions carry the screen, so matrix and code cannot drift
apart silently. Coverage questions are now inspection results, not
review findings.

## 9. Amendment (2026-08-09): proactive promotion — every promotable cell promoted

Challenged on why any promotable cell should wait, the audit split the
non-● cells into promotable-now versus principled-block. Everything
promotable is now promoted:

**Estimator upgrades (reported numbers change).**

- `finding_trend(values, unit=, labels=, counts=)` — with `counts=` the
  fit is COUNT-WEIGHTED least squares: COUNT_SKEWED/THIN_PERIODS answered
  in the estimator instead of a caveat (a 52-item year cannot steer the
  slope like a 12,000-item year). `weighted` reports which fit ran;
  missing per-period counts get the median weight — measurements are
  never dropped for a missing n.
- `finding_heterogeneity` — the test itself is dispatched from the pooled
  regime profile: rank-based Kruskal–Wallis (pure-python H + tie
  correction, chi-square p via a new regularized upper incomplete gamma
  `_gammainc_q`) under HEAVY_TAIL/CONTAMINATED, ANOVA otherwise; `test`
  reports which ran. The select_center pattern applied to the test
  statistic.

**Refusal semantics (NON_MONOTONE_X ▲→●).** `_ordinal_disorder`: an
all-numeric label sequence with an actual descent PROVES disorder — the
order-dependent claims (trend via new `labels=`, step_change,
current_state, outliers, split_comparison) return their no-verdict shape
rather than fit an undefined statistic. Categorical labels stay on the
profile-flag/caveat path: refusing on labels the function cannot rank
would kill legitimate uses. Duplicates allowed (grouped series repeat x).
yoy is order-free and unaffected.

**Bindable evidence (◐/▲→●).** `finding_distribution` returns
`distinct_share`/`modal_share` (DISCRETE/TIED caveats bindable, not
asserted); `finding_heterogeneity` returns `group_ns`;
`finding_correlation` returns `preferred` (spearman under
TIED/HEAVY_TAIL/CONTAMINATED on either axis — dispatch decides emphasis,
both coefficients always reported); `finding_split_comparison` yields
`multiplier` only when BOTH medians are positive — a signed ratio is not
a growth figure, the levels carry the story.

**What remains unpromoted, by principle.** (1) Encodings vs measurements:
the claim layer auto-excludes ENCODINGS (sentinel zeros) but never
silently distrusts MEASUREMENTS — outlier screens stay declared upstream
acts whose output also feeds the record layer. (2) Information absence:
share/decompose currency and row-level cells live where the columns
exist. (3) check row: checks ARE the response layer. Every surviving
◐/○/▲ cell now states which principle holds it.

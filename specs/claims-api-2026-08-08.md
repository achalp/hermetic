# The Claims API: complete coverage, named methods, shorter contract

**Status: v1 implemented 2026-08-08. Companion to declared-findings/-checks.**

## 0. Rationale (from the run-39 design discussion)

Every statistical failure of the session was a correct statistic misused,
never a missing one — the sandbox has scipy/statsmodels. `finding_*` is
therefore a CLAIMS library, not a stats library: each function returns a
defensible claim with the judgment policy baked in. Two consequences:

1. The claim space is BOUNDED (~a dozen claim types) even though the
   statistics space isn't — so the API is finishable, and finishing it
   deliberately beats commissioning one helper per reviewer report.
2. Internals use NAMED, established robust methods (rolling MAD, Theil–Sen
   family) — a definition citing "rolling MAD, k=3.5" is auditable in a way
   "100x the rolling median" never was, and MAD retires the entire
   screen-calibration saga (global → rolling → cluster-poisoned →
   attestation) in one named method: scale-free, tail-robust, era-local.

## 1. Claim-type inventory

| Claim                  | Function                               | Status                                           |
| ---------------------- | -------------------------------------- | ------------------------------------------------ |
| trend                  | finding_trend                          | existing                                         |
| change-point           | finding_step_change                    | existing                                         |
| comparison             | finding_split_comparison / finding_yoy | existing                                         |
| superlative            | finding_superlative                    | existing                                         |
| current state          | finding_current_state                  | existing                                         |
| decomposition          | finding_decompose                      | existing                                         |
| heterogeneity          | finding_heterogeneity                  | existing                                         |
| **outliers/screen**    | **finding_outliers**                   | **new: rolling-MAD, attestation-protected**      |
| **correlation**        | **finding_correlation**                | **new: Pearson + Spearman, scipy p-values**      |
| **distribution shape** | **finding_distribution**               | **new: robust summary, justifies metric choice** |
| **shares**             | **finding_share**                      | **new: parts + residual, must sum**              |

Seasonality is deferred until a dataset demands it (recorded, not built).

## 2. Contract consolidation

Per-incident prompt rules superseded by API mandates are DELETED — the
judgment moves into code and docstrings. Removed: ROBUST BASELINES, LOCAL
BASELINES ON TRENDING SERIES, OUTLIER PLAUSIBILITY (→ "screens MUST use
finding_outliers"), the superlative calibration prose (→ finding_superlative
mandate, already present). The effect-side lints (well_attested_screened,
thin_superlative, screen_missed_superlative) stay — they judge outcomes,
whatever produced them.

## 3. Invariants

- Attestation protection is API-level: a well-attested value (n ≥ max(5,
  20% of median n)) is never flagged an outlier, whatever its magnitude.
- Every function: never raises, degenerate → all-None, pure-Python fallback
  when scipy is absent (p-values None rather than wrong).
- Fallback stubs in the prelude stay in parity.

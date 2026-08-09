"""Regime profiler + claims x regimes matrix (specs/regime-matrix-2026-08-09.md).

The judgment layer of the Claims API, closed in code: deterministic
diagnostics over a series (the REGIME PROFILE), a machine-readable matrix
of which regimes affect which claim types and how, and dispatch helpers so
decisions that used to be per-run model judgment (is zero a sentinel? is
the mean valid?) are one deterministic function call.

Everything is never-raise (repo invariant); a profiling failure degrades to
an empty profile, never a dead analysis. Thresholds are MATRIX DATA, not
scattered constants — each cites its motivating run.
"""

from .coerce import safe_float
from .findings import _attestation_bar

# Currency allowlist for the MONETARY regime — conservative: a miss loses a
# flag, never causes a wrong exclusion (DS review §5.4).
_CURRENCIES = {"usd", "eur", "gbp", "jpy", "dm", "dollar", "dollars",
               "$", "€", "£", "¥", "cents", "cad", "aud", "chf"}

# Diagnostic thresholds (motivating run in comment).
THRESHOLDS = {
    "ZERO_INFLATED": 0.05,   # menu run: 9% zero years defended as data
    "HEAVY_TAIL": 2.0,       # skew 3.72 -> mean 1.86 vs median 0.5
    "CONTAMINATED": 50.0,    # $3,050 item vs low-dollar medians
    "COUNT_SKEWED": 3.0,     # digitization: count mean/median 7.1x
    "SHORT_SERIES": 8,       # inference over fewer periods: report, don't decide
    "DISCRETE": 0.10,        # distinct-share under 10%
    "TIED": 0.30,            # modal value holds >30% of observations
}


def _median(xs):
    s = sorted(xs)
    m = len(s)
    return s[m // 2] if m % 2 else (s[m // 2 - 1] + s[m // 2]) / 2.0


def profile_regimes(values, counts=None, labels=None, unit=None):
    """Deterministic regime profile of one series. Pure; never raises.

    Returns {} on unusable input. Otherwise a dict of diagnostics plus
    "flags": the regimes that fired. Computed ONCE per series and shipped
    in the envelope (write_output auto-profiles declared series), so the
    composer and the audit can see WHY methods were chosen.
    """
    try:
        ys = [safe_float(v) for v in list(values)]
        finite = [y for y in ys if y is not None]
        if len(finite) < 2:
            return {}
        n = len(finite)
        prof = {"n_periods": len(ys), "n_values": n}

        zero_share = sum(1 for y in finite if y == 0) / n
        prof["zero_share"] = round(zero_share, 4)
        prof["negative_share"] = round(sum(1 for y in finite if y < 0) / n, 4)

        mean = sum(finite) / n
        sd = (sum((y - mean) ** 2 for y in finite) / n) ** 0.5
        prof["skew"] = round(
            sum(((y - mean) / sd) ** 3 for y in finite) / n, 3) if sd > 0 else 0.0

        med = _median(finite)
        mx = max(finite)
        prof["tail_ratio"] = round(mx / med, 1) if med > 0 else None

        prof["distinct_share"] = round(len(set(finite)) / n, 3)
        modal = max(finite, key=finite.count)
        prof["modal_share"] = round(finite.count(modal) / n, 3)

        prof["monotone_x"] = True
        if labels is not None:
            try:
                labs = [safe_float(x) for x in list(labels)]
                nums = [x for x in labs if x is not None]
                prof["monotone_x"] = all(a < b for a, b in zip(nums, nums[1:]))
            except Exception:
                pass

        unit_str = str(unit).strip().lower() if unit is not None else ""
        prof["monetary"] = unit_str in _CURRENCIES

        cs = None
        if counts is not None:
            try:
                cs = [safe_float(c) for c in list(counts)]
                if len(cs) != len(ys):
                    cs = None
            except Exception:
                cs = None
        if cs is not None:
            fc = [c for c in cs if c is not None]
            if fc:
                cmed = _median(fc)
                cmean = sum(fc) / len(fc)
                prof["count_median"] = cmed
                prof["count_mean"] = round(cmean, 1)
                prof["count_dispersion"] = round(cmean / cmed, 1) if cmed > 0 else None
                bar = _attestation_bar(fc)
                prof["attestation_bar"] = round(bar, 1) if bar is not None else None
                if bar is not None:
                    prof["thin_periods"] = sum(1 for c in fc if c < bar)
                    trailing = 0
                    for c in reversed(cs):
                        if c is None:
                            continue
                        if c < bar:
                            trailing += 1
                        else:
                            break
                    prof["trailing_thin_run"] = trailing

        t = THRESHOLDS
        flags = []
        if zero_share > t["ZERO_INFLATED"]:
            flags.append("ZERO_INFLATED")
        if prof["skew"] > t["HEAVY_TAIL"]:
            flags.append("HEAVY_TAIL")
        if prof["tail_ratio"] is not None and prof["tail_ratio"] > t["CONTAMINATED"]:
            flags.append("CONTAMINATED")
        if prof.get("count_dispersion") is not None and prof["count_dispersion"] > t["COUNT_SKEWED"]:
            flags.append("COUNT_SKEWED")
        if prof.get("thin_periods"):
            flags.append("THIN_PERIODS")
        if prof.get("trailing_thin_run"):
            flags.append("THIN_EDGE")
        if n < t["SHORT_SERIES"]:
            flags.append("SHORT_SERIES")
        if prof["distinct_share"] < t["DISCRETE"]:
            flags.append("DISCRETE")
        if prof["modal_share"] > t["TIED"]:
            flags.append("TIED")
        if prof["negative_share"] > 0:
            flags.append("NEGATIVE_VALUED")
        if not prof["monotone_x"]:
            flags.append("NON_MONOTONE_X")
        if prof["monetary"]:
            flags.append("MONETARY")
        prof["flags"] = flags
        return prof
    except Exception:
        return {}


# ── The matrix (spec §1, closed per amendment §8): claim type x regime ───
# THE completeness artifact, FULLY CLOSED: every row carries every regime
# key, each cell a response string or explicitly None (deliberate N/A —
# the regime cannot corrupt this claim, or the hazard belongs to another
# claim's row). The meta-test asserts full closure, so "is the set
# exhaustive?" is answered by inspection, never by asking or by a
# production run. A sparse row was exactly how the zero-sentinel gap hid:
# absence was ambiguous between "addressed elsewhere" and "never audited".
#
# Response tags: (implemented) = enforced inside the claim function;
# (upstream) = enforced by another layer (contract, lints, SQL, another
# claim); (caveat) = profile flag -> composer caveat, not refused in-code;
# (accepted) = known limitation, documented and visible in outputs.
_ALL_REGIMES = ("ZERO_INFLATED", "HEAVY_TAIL", "CONTAMINATED",
                "COUNT_SKEWED", "THIN_PERIODS", "THIN_EDGE", "SHORT_SERIES",
                "DISCRETE", "TIED", "NEGATIVE_VALUED", "NON_MONOTONE_X",
                "MONETARY")

REGIME_MATRIX = {
    "trend": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented: _zero_screen before the fit)",
        "HEAVY_TAIL": "CI mandatory (slope_ci95, implemented); median-based series preferred (upstream)",
        "CONTAMINATED": "screen the measure with finding_outliers — same policy — before fitting (upstream)",
        "COUNT_SKEWED": "count-weighted least squares via counts= (implemented) — a 52-item year cannot steer the slope like a 12,000-item year",
        "THIN_PERIODS": "counts= WLS downweights thin periods in the estimator itself (implemented)",
        "THIN_EDGE": "counts= WLS downweights a thin edge; endpoint claims still delegate to current_state (implemented)",
        "SHORT_SERIES": "degrade: direction None under n<3; report without verdict n<8 (implemented)",
        "DISCRETE": None,  # OLS is defined regardless of cardinality
        "TIED": None,
        "NEGATIVE_VALUED": None,  # the fit is sign-indifferent
        "NON_MONOTONE_X": "refuses when numeric labels are disordered (implemented: labels=); categorical labels stay on the caveat path",
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    "step_change": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented) — a trailing $0 sentinel manufactures a full-magnitude down-step that passes all three gates",
        "HEAVY_TAIL": "spike-reversion gate (implemented): an outlier before-level cannot host a step",
        "CONTAMINATED": "magnitude gate is spread-relative (3x median |delta|) + spike-reversion gate (implemented)",
        "COUNT_SKEWED": "edge-period counts gate (implemented: counts= in finding_step_change)",
        "THIN_PERIODS": "edge-period counts gate (implemented: counts= in finding_step_change)",
        "THIN_EDGE": "counts= gate refuses a step landing on a thin trailing period (implemented)",
        "SHORT_SERIES": "degrade: no step verdict (implemented)",
        "DISCRETE": None,
        "TIED": None,
        "NEGATIVE_VALUED": "direction bound from delta sign (implemented) — never inferred from context",
        "NON_MONOTONE_X": "refuses (no verdict) when numeric labels are disordered (implemented); categorical labels stay on the caveat path",
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    "comparison": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented: split_comparison; yoy — an all-sentinel month drops from BOTH windows)",
        "HEAVY_TAIL": "median-based by construction (early/late medians, implemented)",
        "CONTAMINATED": "medians robust to point contamination; screen the measure upstream for level claims",
        "COUNT_SKEWED": "both windows must be attested; spans AND n comparable (upstream: contract)",
        "THIN_PERIODS": "early_n/late_n reported — imbalance visible, never silent (implemented)",
        "THIN_EDGE": "yoy restricts both years to overlapping months (implemented)",
        "SHORT_SERIES": "degrade: all-None under n<6 (split) / <2 years (yoy) (implemented)",
        "DISCRETE": None,
        "TIED": None,
        "NEGATIVE_VALUED": "multiplier only when BOTH medians are positive (implemented); levels always reported",
        "NON_MONOTONE_X": "split refuses when numeric labels are disordered (implemented); yoy is order-free",
        "MONETARY": "single-unit restriction upstream (currency check); modifier for the zero screen",
    },
    "superlative": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented) — a $0 sentinel cannot be crowned kind='min'",
        "HEAVY_TAIL": None,  # the extreme IS the claim; validity handled by CONTAMINATED/attestation
        "CONTAMINATED": "screen the measure before crowning an extreme (upstream)",
        "COUNT_SKEWED": "attestation bar (implemented: _attestation_bar); raw ALWAYS beside",
        "THIN_PERIODS": "thin periods cannot host the attested extreme (implemented)",
        "THIN_EDGE": "same attestation bar covers a thin trailing period (implemented)",
        "SHORT_SERIES": None,  # an extreme is valid at any n; degenerate input -> all-None
        "DISCRETE": "ties for the extreme: first-encountered wins, deterministic (implemented)",
        "TIED": "ties for the extreme: first-encountered wins, deterministic (implemented)",
        "NEGATIVE_VALUED": None,  # max/min are sign-agnostic
        "NON_MONOTONE_X": None,  # order-free statistic
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    "current_state": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented) — a trailing $0 year is unrecorded, not an endpoint",
        "HEAVY_TAIL": "direction vs prior-window MEDIAN — robust recent level (implemented)",
        "CONTAMINATED": "attestation-consistent reference peak; magnitude walk-back capped at 2 (implemented)",
        "COUNT_SKEWED": "attestation-consistent reference peak (implemented)",
        "THIN_PERIODS": "attestation gate on the walk-back (implemented: counts=)",
        "THIN_EDGE": "walk back with excluded_reason; latest_* always reported (implemented)",
        "SHORT_SERIES": "degrade: all-None under n<2 (implemented)",
        "DISCRETE": None,
        "TIED": None,
        "NEGATIVE_VALUED": "pct_from_peak uses |peak| denominator (implemented)",
        "NON_MONOTONE_X": "refuses when numeric labels are disordered (implemented); categorical labels stay on the caveat path",
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    "outliers": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented) — sentinels are encodings, not anomalies",
        "HEAVY_TAIL": "rolling MAD (scale-free) — the reason the method is pinned (implemented)",
        "CONTAMINATED": "the claim exists to catch this; MAD is tail-robust — an error cluster cannot raise its own bar (implemented)",
        "COUNT_SKEWED": "attestation protection: well-attested values are never flagged (implemented)",
        "THIN_PERIODS": "thin values remain flaggable — attestation protects, never exempts the thin (implemented)",
        "THIN_EDGE": None,  # edge completeness is current_state's claim
        "SHORT_SERIES": "degrade: all-None under n<5 (implemented)",
        "DISCRETE": "MAD=0 neighborhoods are skipped, never divided by (implemented)",
        "TIED": "MAD=0 neighborhoods are skipped, never divided by (implemented)",
        "NEGATIVE_VALUED": None,
        "NON_MONOTONE_X": "refuses when numeric labels are disordered (implemented); categorical labels stay on the caveat path",
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    "correlation": {
        "ZERO_INFLATED": "zero screen inside x_unit=/y_unit= (implemented); a screened member drops its pair",
        "HEAVY_TAIL": "Spearman beside Pearson + preferred-coefficient dispatch (implemented)",
        "CONTAMINATED": "Spearman over Pearson (rank-robust); preferred field names it, both reported (implemented)",
        "COUNT_SKEWED": None,  # raw pairs, no counts surface; aggregate-input correlations inherit upstream attestation
        "THIN_PERIODS": None,
        "THIN_EDGE": None,
        "SHORT_SERIES": "p-values unreliable; report n prominently (implemented: n in payload)",
        "DISCRETE": "rank averaging handles ties; prefer Spearman semantics (implemented)",
        "TIED": "ties inflate Pearson; preferred field names spearman, both reported (implemented)",
        "NEGATIVE_VALUED": None,
        "NON_MONOTONE_X": None,  # order-free statistic
        "MONETARY": "modifier: per-axis units (x_unit=/y_unit=) enable the zero screen",
    },
    "distribution": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented) — $0 sentinels are not the distribution's floor",
        "HEAVY_TAIL": None,  # the claim MEASURES this: skew and mean/median gap are its outputs
        "CONTAMINATED": "min/max reported raw so contamination is visible; median/MAD beside moments (implemented)",
        "COUNT_SKEWED": None,  # raw values, no counts surface
        "THIN_PERIODS": None,
        "THIN_EDGE": None,
        "SHORT_SERIES": "degrade: all-None under n<3; n reported (implemented)",
        "DISCRETE": "distinct_share in the payload — the caveat is bindable, not asserted (implemented)",
        "TIED": "modal_share in the payload — the caveat is bindable, not asserted (implemented)",
        "NEGATIVE_VALUED": None,
        "NON_MONOTONE_X": None,
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    "share": {
        "ZERO_INFLATED": None,  # decided N/A: a zero part contributes nothing to a sum — matches sentinel semantics; share 0 is the honest rendering
        "HEAVY_TAIL": None,
        "CONTAMINATED": "parts are aggregates — screen the measure upstream before sharing",
        "COUNT_SKEWED": None,
        "THIN_PERIODS": None,
        "THIN_EDGE": None,
        "SHORT_SERIES": None,
        "DISCRETE": None,
        "TIED": None,
        "NEGATIVE_VALUED": "shares of signed quantities need explicit residual handling (implemented: residual_pct + sums_to_100)",
        "NON_MONOTONE_X": None,
        "MONETARY": "single-unit restriction upstream — pooled-currency parts are invalid",
    },
    "decompose": {
        "ZERO_INFLATED": None,  # decided N/A: terms are computed contributions; zero = genuinely contributed nothing
        "HEAVY_TAIL": None,
        "CONTAMINATED": "residual exposes mis-specification — terms that don't explain the change leave a large residual (implemented)",
        "COUNT_SKEWED": None,
        "THIN_PERIODS": None,
        "THIN_EDGE": None,
        "SHORT_SERIES": None,
        "DISCRETE": None,
        "TIED": None,
        "NEGATIVE_VALUED": "signed terms: dominant by |magnitude|, residual disclosed (implemented)",
        "NON_MONOTONE_X": None,
        "MONETARY": "single-unit restriction upstream — mixed-currency terms are invalid",
    },
    "heterogeneity": {
        "ZERO_INFLATED": "zero screen inside unit= (implemented) — pooled policy, applied per group",
        "HEAVY_TAIL": "Kruskal–Wallis dispatched from the pooled profile; test field reports which ran (implemented)",
        "CONTAMINATED": "rank-based Kruskal–Wallis under contamination — one transcription error cannot own the variance (implemented)",
        "COUNT_SKEWED": None,  # groups, not counted periods
        "THIN_PERIODS": None,
        "THIN_EDGE": None,
        "SHORT_SERIES": "group_ns in the payload — a thin-group verdict is bindable as such (implemented)",
        "DISCRETE": None,
        "TIED": "variance assumptions degrade under heavy ties (caveat)",
        "NEGATIVE_VALUED": None,
        "NON_MONOTONE_X": None,  # groups are unordered
        "MONETARY": "modifier: with ZERO_INFLATED enables sentinel exclusion (zero_policy)",
    },
    # Checks ARE the response layer; no dispatch applies to any regime.
    "check": {r: None for r in _ALL_REGIMES},
}


# ── Rendered view: the matrix as a table, generated never hand-drawn ─────
# The spec embeds matrix_table()'s output verbatim between MATRIX-TABLE
# markers and a test pins them equal — the recorded table cannot drift
# from the code, and an untagged cell renders "?" and fails the meta-test.

_SYMBOL_TAGS = (("modifier", "◆"), ("implemented", "●"), ("upstream", "◐"),
                ("caveat", "▲"), ("accepted", "○"))

_COLUMN_ABBREV = {"ZERO_INFLATED": "Z_INFL", "HEAVY_TAIL": "H_TAIL",
                  "CONTAMINATED": "CONTAM", "COUNT_SKEWED": "C_SKEW",
                  "THIN_PERIODS": "THIN_P", "THIN_EDGE": "THIN_E",
                  "SHORT_SERIES": "SHORT", "DISCRETE": "DISC",
                  "TIED": "TIED", "NEGATIVE_VALUED": "NEG",
                  "NON_MONOTONE_X": "N_MONO", "MONETARY": "MONEY"}


def cell_symbol(response):
    """Symbol for one matrix cell, derived from its tag — None -> "—",
    untagged prose -> "?" (rejected by the meta-test)."""
    if response is None:
        return "—"
    for tag, symbol in _SYMBOL_TAGS:
        if tag in response:
            return symbol
    return "?"


def matrix_table():
    """The REGIME_MATRIX as a GitHub-flavored markdown symbol table.

    Legend: ● enforced inside the claim function; ◐ enforced upstream
    (contract/lints/SQL/another claim); ▲ profile flag -> composer caveat;
    ○ accepted limitation, documented; ◆ modifier (enables a dispatch);
    — explicit N/A.
    """
    cols = list(_ALL_REGIMES)
    lines = [
        "| Claim | " + " | ".join(_COLUMN_ABBREV[c] for c in cols) + " |",
        "|---" * (len(cols) + 1) + "|",
    ]
    for claim, cells in REGIME_MATRIX.items():
        lines.append(
            "| " + claim + " | "
            + " | ".join(cell_symbol(cells[c]) for c in cols) + " |"
        )
    return "\n".join(lines)


# ── Dispatchers: per-run judgment closed into functions ──────────────────

def select_center(profile):
    """Which central tendency is valid for this series.

    Returns {"center": "median"|"mean", "reason": str}. The SKEWED-MONEY
    contract rule as code: under HEAVY_TAIL or CONTAMINATED the mean is not
    a central tendency (menu run: mean 1.86 vs median 0.50 under skew 3.72).
    Never raises.
    """
    try:
        flags = set(profile.get("flags", []))
        if "HEAVY_TAIL" in flags or "CONTAMINATED" in flags:
            return {"center": "median",
                    "reason": "heavy tail (skew %s, tail ratio %s): mean is not a central tendency here"
                              % (profile.get("skew"), profile.get("tail_ratio"))}
        return {"center": "mean", "reason": "no heavy-tail regime fired"}
    except Exception:
        return {"center": "median", "reason": "profile unavailable; median is the safe default"}


def zero_policy(profile):
    """Sentinel adjudication for zeros — the decision that FLIPPED between
    two identical runs, closed: on a MONETARY measure with ZERO_INFLATED
    fired, zeros are an unrecorded-value encoding and are excluded at the
    record level (with the share reported); otherwise keep, with the share
    reported regardless so near-threshold cases stay visible. Never raises.
    """
    try:
        flags = set(profile.get("flags", []))
        share = profile.get("zero_share", 0.0)
        if "ZERO_INFLATED" in flags and "MONETARY" in flags:
            return {"policy": "sentinel_exclude", "zero_share": share,
                    "reason": "zeros are %.1f%% of a monetary measure — an unrecorded-price encoding, not free items"
                              % (100 * (share or 0))}
        return {"policy": "keep", "zero_share": share,
                "reason": "zero share %.1f%% under the sentinel bar or measure not monetary — zeros treated as data"
                          % (100 * (share or 0))}
    except Exception:
        return {"policy": "keep", "zero_share": None, "reason": "profile unavailable"}

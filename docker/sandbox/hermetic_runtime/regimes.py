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


# ── The matrix (spec §1): claim type x regime -> response ────────────────
# THE completeness artifact: every cell either names its response or is
# explicitly None (not applicable). The meta-test asserts every regime
# named here has a diagnostic and every claim type has a row — empty cells
# are found by inspection, never by production runs.
REGIME_MATRIX = {
    "trend": {
        "HEAVY_TAIL": "CI mandatory (slope_ci95); median-based series preferred",
        "SHORT_SERIES": "degrade: direction None under n<3; report without verdict n<8",
        "ZERO_INFLATED": "sentinel adjudication BEFORE fitting (zero_policy)",
        "NON_MONOTONE_X": "sort or refuse — a trend over unordered x is undefined",
    },
    "step_change": {
        "THIN_PERIODS": "edge-period counts gate (implemented: counts= in finding_step_change)",
        "SHORT_SERIES": "degrade: no step verdict",
    },
    "comparison": {
        "COUNT_SKEWED": "both windows must be attested; spans AND n comparable",
        "MONETARY": "single-unit restriction upstream (currency check)",
    },
    "superlative": {
        "COUNT_SKEWED": "attestation bar (implemented: _attestation_bar); raw ALWAYS beside",
        "THIN_PERIODS": "thin periods cannot host the attested extreme",
        "CONTAMINATED": "screen the measure before crowning an extreme",
    },
    "current_state": {
        "THIN_EDGE": "walk back with excluded_reason; latest_* always reported",
        "COUNT_SKEWED": "attestation-consistent reference peak",
    },
    "outliers": {
        "COUNT_SKEWED": "attestation protection (well-attested never flagged)",
        "HEAVY_TAIL": "rolling MAD (scale-free) — the reason the method is pinned",
    },
    "correlation": {
        "CONTAMINATED": "Spearman over Pearson (rank-robust); report both",
        "TIED": "ties inflate Pearson; prefer Spearman/Kendall semantics",
        "SHORT_SERIES": "p-values unreliable; report n prominently",
    },
    "distribution": {
        "DISCRETE": "quartiles collapse under low cardinality; report distinct_share",
    },
    "share": {
        "NEGATIVE_VALUED": "shares of signed quantities need explicit residual handling",
    },
    "decompose": {
        "NEGATIVE_VALUED": "signed terms: dominant by |magnitude|, residual disclosed",
    },
    "heterogeneity": {
        "SHORT_SERIES": "ANOVA over tiny groups: report group ns",
        "TIED": "variance assumptions degrade under heavy ties",
    },
    "check": {},  # checks ARE the response layer; no dispatch applies
}


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

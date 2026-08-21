"""declare_finding + finding stat helpers (specs/declared-findings-2026-08-06.md §2).

The producer side of the declared-findings grammar: code-gen declares the
findings a question warrants, adjacent to the computation that produced them.
Each declaration lands in TWO places (spec §2.1):

- an in-memory registry — the primary source `write_output` reads, so the
  envelope needs no findings argument;
- a JSONL sidecar (`/data/findings.jsonl`) appended per call, so declarations
  survive a later crash and the host can read them independently of the
  envelope.

Everything here is never-raise (repo convention for sandbox helpers — a
metadata feature must never kill an analysis, spec §2.2). Collision policy is
last-wins but HOST-side (§2.3): this module keeps every line in order and
never dedupes.

The stat helpers are a LIBRARY, not a menu (spec §0 — helpers must not become
the fixed taxonomy one level down): small, tested, never-raise dict producers.
The model still calls declare_finding itself. Pure-python math (exact p-values
via the regularized incomplete beta) so results are identical with or without
numpy; scipy is preferred for ANOVA when importable.
"""

import json
import math

from .coerce import safe_float, to_native, numpy_or_none

# Module-level so tests and non-docker runtimes can repoint it. The file may
# not be writable everywhere (host test runs) — _sidecar_write swallows.
SIDECAR_PATH = "/data/findings.jsonl"

_registry = []


def get_findings():
    """Snapshot of this run's declared findings, in declaration order."""
    return list(_registry)


def reset_findings():
    """Test hook: clear the in-run registry (the sidecar is append-only)."""
    del _registry[:]


def _safe_name(name):
    # A printable name for entries AND dropped-diagnostic lines; never raises.
    try:
        return name if isinstance(name, str) else str(name)
    except Exception:
        return "<unprintable>"


def _sidecar_write(obj):
    # One json.dumps per line, append mode (spec §2.1). Failures are swallowed:
    # the in-memory registry still carries the entry for write_output.
    try:
        with open(SIDECAR_PATH, "a") as f:
            f.write(json.dumps(obj, default=str) + "\n")
    except Exception:
        pass


def _code_ref(frame):
    # Generated-code-relative line ref (spec §2.4). The script executes with a
    # ~500-line prelude prepended, so the raw lineno points that far past the
    # statement it cites. The prelude self-measures its line count into the
    # script's module global _HERMETIC_PRELUDE_LINES (never a hardcoded
    # constant); subtract it when present, clamp at 1. Absent (bare exec, host
    # tests) the raw lineno is still monotonic and useful.
    try:
        lineno = int(frame.f_lineno)
        offset = frame.f_globals.get("_HERMETIC_PRELUDE_LINES")
        if isinstance(offset, int) and not isinstance(offset, bool) and offset > 0:
            lineno -= offset
        return "script.py:%d" % max(1, lineno)
    except Exception:
        return None


# declare_finding(name, value, definition, dtype, unit, ...) positional slots
# of the literal-only params, so a positionally-passed definition is checked too.
_LITERAL_PARAM_POSITIONS = {2: "definition", 4: "unit", 8: "method"}


def _literal_violation(frame):
    """Name of the first literal-rule violation at the call site, else None.

    Spec §2.2 (the values-leak): definition/method/unit must be string
    literals — f"spike of {delta:.1f}pp" walks computed values through the
    metadata wall, so JoinedStr/BinOp/Name/... call-site nodes drop the entry.
    Fail-OPEN when the source can't be read or parsed: this is defense in
    depth, the host scrubs at the composer boundary regardless.
    """
    try:
        import ast
        import linecache

        filename = frame.f_code.co_filename
        lineno = frame.f_lineno
        linecache.checkcache(filename)
        src = "".join(linecache.getlines(filename))
        if not src:
            return None
        for node in ast.walk(ast.parse(src)):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            fname = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if fname != "declare_finding":
                continue
            if not (node.lineno <= lineno <= getattr(node, "end_lineno", node.lineno)):
                continue
            checked = {}
            for i, arg in enumerate(node.args):
                if i in _LITERAL_PARAM_POSITIONS:
                    checked[_LITERAL_PARAM_POSITIONS[i]] = arg
            for kw in node.keywords:
                if kw.arg in ("definition", "unit", "method"):
                    checked[kw.arg] = kw.value
            for pname in ("definition", "method", "unit"):
                val = checked.get(pname)
                if val is None:
                    continue  # not passed at this call site — nothing to leak
                if isinstance(val, ast.Constant) and (
                    val.value is None or isinstance(val.value, str)
                ):
                    continue
                return pname
            return None
        return None
    except Exception:
        return None  # unreadable/unparseable source → accept (fail-open)


def declare_finding(
    name,
    value,
    definition,
    dtype,
    unit=None,
    derived_from_findings=None,
    derived_from_columns=None,
    tags=None,
    method=None,
    _frame_depth=1,
):
    """Declare a finding adjacent to the computation that produced it.

    Appends one entry to the in-run registry (write_output includes it
    automatically) and one JSONL line to the findings sidecar. The value is
    to_native-coerced NOW — the frame is live, and a raw np.nan surviving to
    write_output's allow_nan=False would crash the whole run (spec §2.2).
    NEVER raises; a dropped declaration records a {"__dropped__": true, ...}
    sidecar diagnostic. Returns the entry dict, or None when dropped.
    """
    try:
        import sys

        # _frame_depth lets sugar wrappers (declare_check) point the literal
        # audit at the USER's call site — the literal rule applies there too.
        frame = sys._getframe(_frame_depth)
        bad = _literal_violation(frame)
        if bad is not None:
            _sidecar_write(
                {"__dropped__": True, "name": _safe_name(name), "reason": "literal_rule: %s" % bad}
            )
            return None
        # Field names match contracts/findings.ts FindingEntry EXACTLY.
        entry = {
            "name": _safe_name(name),
            "definition": definition if isinstance(definition, str) else str(definition),
            "dtype": dtype if isinstance(dtype, str) else str(dtype),
            "value": to_native(value),
        }
        # Optional fields: each coerced in its own try — a garbage tags arg
        # must not take the whole declaration down with it.
        if unit is not None:
            try:
                entry["unit"] = unit if isinstance(unit, str) else str(unit)
            except Exception:
                pass
        for key, val in (
            ("derived_from_findings", derived_from_findings),
            ("derived_from_columns", derived_from_columns),
            ("tags", tags),
        ):
            if val:
                try:
                    entry[key] = [x if isinstance(x, str) else str(x) for x in list(val)]
                except Exception:
                    pass
        if method is not None:
            try:
                entry["method"] = method if isinstance(method, str) else str(method)
            except Exception:
                pass
        ref = _code_ref(frame)
        if ref is not None:
            entry["code_ref"] = ref
        _registry.append(entry)
        _sidecar_write(entry)
        return entry
    except Exception as err:  # never-raise: outermost catch (spec §2.2)
        try:
            _sidecar_write(
                {"__dropped__": True, "name": _safe_name(name), "reason": "internal: %s" % err}
            )
        except Exception:
            pass
        return None


# ── Exact p-values without scipy ─────────────────────────────────────────────
# Regularized incomplete beta via the standard Lentz continued fraction — the
# t and F distributions both reduce to it, so trend/heterogeneity p-values are
# EXACT in pure python (no normal approximation that would flip a borderline
# "flat" verdict depending on which libraries the image happens to carry).


def _attestation_bar(ns):
    """The thin-data bar: max(min(5, median), 20% of the median period
    size, 10% of the MEAN period size).

    Two relative references, because two failure modes:
      - 0.2 * median guards ordinary corpora (a 52-item year cannot headline
        a series whose typical year holds 600).
      - 0.1 * mean guards HEAVY-TAILED corpora, where a long sparse tail
        drags the period median down: the mean is corpus-mass-per-period, so
        the floor tracks where the observations live (a 178.8 median-bar let
        a 382-item final year headline a corpus with a 124k-item year; the
        mean floor of ~600 refuses it). For balanced series mean < 2*median,
        so the median term dominates and nothing changes.
    The absolute floor is CAPPED AT THE MEDIAN: thinness is RELATIVE, and a
    period matching the corpus-typical count cannot be thin whatever its
    absolute size. A flat floor of 5 declared EVERY month of a uniformly
    4-counted corpus thin (audited: current_state walked back 10 of 12
    months to "as of 2024-02" and a 9.5x-spread step change was suppressed,
    all under full coverage). With the cap, at least the median-sized half
    of the corpus is always attested — "everything is thin" is
    unrepresentable.
    A COUNT-WEIGHTED median was tried here and over-corrected (audited:
    thin_bar 11,297 excluded 90% of years and walked current-state back to
    1933) — the mean floor is the gentle version of the same idea.
    ns: finite numbers, any order. Returns None when empty; never raises.
    """
    try:
        s = sorted(ns)
        if not s:
            return None
        med = s[len(s) // 2]
        mean = float(sum(s)) / len(s)
        return max(min(_THIN_FLOOR, med), 0.2 * med, 0.1 * mean)
    except Exception:
        return None


# The absolute thin-data floor, before the median cap relaxes it. Named so a
# claim can report WHETHER it was relaxed: two superlatives in one run can
# legitimately carry different thin_bars (the bar is series-relative), and a
# reader comparing them cannot otherwise tell that one rested on a softer
# rule. Audited (run 77051c9d): categories got thin_bar 5 and skipped an n=3
# group, while payees — nearly all n=1, so the floor collapsed to 1 — crowned
# an n=3 payee as the month's top. Same n, opposite treatment, silently.
_THIN_FLOOR = 5.0

# Catch-all bucket labels. A superlative these win is a statement about
# UNCLASSIFIED residue, not about a real category — audited (run 77051c9d):
# "Other" (n=45, 35% of transactions) headlined a spend analysis as the
# month's dominant category with no disclosure that it is the leftovers.
_CATCHALL_LABELS = {
    "other", "others", "unknown", "unclassified", "uncategorized",
    "uncategorised", "misc", "miscellaneous", "n/a", "na", "none",
    "unspecified", "ungrouped", "unmapped",
}


def _is_catchall_label(label):
    """True when a label is a residue bucket rather than a real category.
    Conservative and exact-match after normalisation: a genuine category
    called "Other Income" keeps its meaning and must not be flagged."""
    try:
        if label is None:
            return None
        norm = str(label).strip().lower().strip("()[]").strip()
        return norm in _CATCHALL_LABELS
    except Exception:
        return None


def _zero_screen(values, counts=None, labels=None, unit=None):
    """Apply zero_policy INSIDE the claim layer (regime-matrix spec,
    claim-layer totalization amendment).

    The dispatcher alone was ADVISORY — a run declared a blocking
    zero-sentinel check citing the policy, reported n_excluded=0, and left
    12 $0.00 year-rows in every downstream figure. Threading unit= through
    the claim functions closes that gap the same way counts= closed
    attestation: the model passes what it KNOWS (the measure's unit), the
    judgment is deterministic. profile_regimes + zero_policy run here;
    under "sentinel_exclude" (MONETARY measure, zero share over the bar)
    zeros become None BEFORE the statistic is computed, and the count is
    reported back as n_zero_excluded so the narrative can bind it.

    A zero whose sibling COUNT is also zero is a REAL observation (audited,
    run d82a39ce): a $0.00 day with transaction_count 0 is a day nothing
    happened — excluding it as a sentinel biased the slope, the outlier
    screen and the endpoint of every daily claim in the run. The sentinel
    reading ("value unrecorded") requires activity the value fails to
    reflect: count > 0, or no count information at all.

    Returns (values_list, n_zero_excluded). unit=None short-circuits to
    (input, 0) — MONETARY cannot fire without a unit, so there is nothing
    to profile. Never raises.
    """
    try:
        vals = list(values)
    except Exception:
        return values, 0
    if unit is None:
        return vals, 0
    try:
        # Lazy import: regimes.py imports _attestation_bar from this module
        # at module level, so the reverse edge must resolve at call time.
        from .regimes import profile_regimes, zero_policy

        prof = profile_regimes(vals, counts=counts, labels=labels, unit=unit)
        if zero_policy(prof).get("policy") != "sentinel_exclude":
            return vals, 0
        cnts = None
        if counts is not None:
            try:
                cnts = list(counts)
            except Exception:
                cnts = None
        screened = []
        n_excluded = 0
        for i, v in enumerate(vals):
            fv = safe_float(v)
            if fv is not None and fv == 0:
                cv = safe_float(cnts[i]) if cnts is not None and i < len(cnts) else None
                if cv is not None and cv == 0:
                    screened.append(v)  # count-corroborated real zero
                    continue
                screened.append(None)
                n_excluded += 1
            else:
                screened.append(v)
        return screened, n_excluded
    except Exception:
        return vals, 0


def _betacf(a, b, x):
    max_iter, eps, fpmin = 300, 3e-12, 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            break
    return h


def _betainc_reg(a, b, x):
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_front = (
        math.lgamma(a + b)
        - math.lgamma(a)
        - math.lgamma(b)
        + a * math.log(x)
        + b * math.log(1.0 - x)
    )
    front = math.exp(ln_front)
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _betacf(a, b, x) / a
    return 1.0 - front * _betacf(b, a, 1.0 - x) / b


def _t_p_two_sided(t, df):
    # P(|T_df| >= |t|) — exact via I_x(df/2, 1/2) at x = df/(df + t^2).
    return _betainc_reg(df / 2.0, 0.5, df / (df + t * t))


def _t_crit_95(df):
    # Two-sided 95% t critical value: the t where _t_p_two_sided(t, df) == 0.05.
    # Inverts the exact t tail by bisection (the tail decreases as t grows) so the
    # CI band widens correctly for small df — the normal 1.96 is only the df→∞
    # limit and badly understates uncertainty at low n (df=1 → ~12.71, not 1.96).
    if df <= 0:
        return 1.96
    lo, hi = 1.96, 60.0  # t_crit ∈ [1.96, ~12.71] for df ≥ 1; 1.96 is the df→∞ floor
    for _ in range(60):
        mid = (lo + hi) / 2.0
        if _t_p_two_sided(mid, df) > 0.05:
            lo = mid  # critical t is larger
        else:
            hi = mid
    return (lo + hi) / 2.0


def _f_p(f_stat, df1, df2):
    # P(F_{df1,df2} >= f) — exact via I_x(df2/2, df1/2) at x = df2/(df2 + df1·f).
    return _betainc_reg(df2 / 2.0, df1 / 2.0, df2 / (df2 + df1 * f_stat))


def _gammainc_q(a, x):
    # Regularized UPPER incomplete gamma Q(a, x) — the chi-square survival
    # function: P(X²_df >= x) = Q(df/2, x/2). Series for the P-side when
    # x < a+1, Lentz continued fraction for Q otherwise (same numerical
    # family as _betacf). Pure python, exact to ~1e-12; None on bad input.
    if a <= 0 or x < 0:
        return None
    if x == 0:
        return 1.0
    if x < a + 1.0:
        ap = a
        s = 1.0 / a
        d = s
        for _ in range(300):
            ap += 1.0
            d *= x / ap
            s += d
            if abs(d) < abs(s) * 3e-12:
                break
        return 1.0 - s * math.exp(-x + a * math.log(x) - math.lgamma(a))
    fpmin = 1e-300
    b = x + 1.0 - a
    c = 1.0 / fpmin
    d = 1.0 / b
    h = d
    for i in range(1, 300):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < fpmin:
            d = fpmin
        c = b + an / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 3e-12:
            break
    return h * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _kw_p(samples):
    # Kruskal–Wallis H with tie correction; p from the chi-square
    # approximation (df = k-1) via _gammainc_q. None when degenerate.
    try:
        allv = sorted(
            ((v, gi) for gi, s in enumerate(samples) for v in s), key=lambda t: t[0]
        )
        n_total = len(allv)
        if n_total < 3 or len(samples) < 2:
            return None
        ranks = [0.0] * n_total
        ties = 0.0
        i = 0
        while i < n_total:
            j = i
            while j + 1 < n_total and allv[j + 1][0] == allv[i][0]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for t in range(i, j + 1):
                ranks[t] = avg
            span = j - i + 1
            ties += span ** 3 - span
            i = j + 1
        rank_sums = [0.0] * len(samples)
        for (v, gi), r in zip(allv, ranks):
            rank_sums[gi] += r
        h = (12.0 / (n_total * (n_total + 1))) * sum(
            rs * rs / len(s) for rs, s in zip(rank_sums, samples)
        ) - 3.0 * (n_total + 1)
        denom = 1.0 - ties / float(n_total ** 3 - n_total)
        if denom <= 0:  # every value identical: no test
            return None
        return _gammainc_q((len(samples) - 1) / 2.0, (h / denom) / 2.0)
    except Exception:
        return None


def _clean_series(values):
    # (index, float) pairs with NaN/None dropped but ORIGINAL spacing kept —
    # a gap in the series must not compress the time axis under the slope.
    return [
        (i, f) for i, f in enumerate(safe_float(v) for v in list(values)) if f is not None
    ]


def _ordinal_disorder(labels):
    """True when labels PROVE the series is out of order (NON_MONOTONE_X).

    Only an all-numeric label set can prove disorder — categorical labels
    ("Jan", "east") return False and stay on the profile-flag/caveat path,
    because refusing on labels the function cannot rank would kill
    legitimate uses to guard against a mistake it cannot confirm.
    Duplicates are allowed (grouped series legitimately repeat x); only an
    actual DESCENT anywhere is disorder. Never raises.
    """
    try:
        labs = [safe_float(x) for x in list(labels)]
        if not labs or any(x is None for x in labs):
            return False
        return any(b < a for a, b in zip(labs, labs[1:]))
    except Exception:
        return False


def finding_trend(values, unit=None, labels=None, counts=None):
    """Least-squares trend over an ordered series → direction/slope/p dict.

    Returns {"direction": "rising"|"falling"|"flat", "slope_per_period",
    "p_value", "slope_ci95", "n_zero_excluded", "weighted"} (plus "unit"
    passthrough when given) —
    slope_ci95 is the ~95% confidence interval [low, high] (t-based standard
    error, normal critical value), so a point-estimate slope never ships
    without its uncertainty. "flat" means the slope's two-sided t-test
    p >= 0.05, not slope == 0. Never raises; a series too
    short or degenerate for inference → {"direction": None, ...}. DEGENERATE
    GATE: an all-zero series, or one where >50% of inputs were dropped as
    missing, returns direction None — slope 0 / p 1 five findings in a row is
    the signature of a regression over nulled data, and labeling it "flat"
    turns a pipeline failure into a confident false claim (a series rising
    243 -> 52,868 was narrated as "flat trajectory").

    ALWAYS pass unit= for monetary measures: zero_policy runs internally
    (_zero_screen) and sentinel zeros are excluded from the fit, reported
    as n_zero_excluded — the trend and every other unit=-passed claim then
    share ONE zero policy by construction.

    ALWAYS pass counts= (observations per period) when periods aggregate
    rows: the fit becomes COUNT-WEIGHTED least squares — a 52-item year
    cannot steer the slope like a 12,000-item year (the COUNT_SKEWED /
    THIN_PERIODS response, in the estimator instead of a caveat). The
    "weighted" flag reports which fit ran; a period with a missing count
    gets the median weight (measurements are never dropped for a missing
    n). Pass labels= so a provably disordered series (numeric labels out
    of order) is REFUSED rather than fit — a trend over unordered x is
    undefined.
    """
    failed = {"detected": False, "direction": None, "slope_per_period": None, "p_value": None,
              "slope_ci95": None, "n_zero_excluded": None, "weighted": False}
    try:
        if labels is not None and _ordinal_disorder(labels):
            return failed
        values, n_zx = _zero_screen(values, counts=counts, labels=labels, unit=unit)
        pts = _clean_series(values)
        try:
            total = len(list(values))
        except Exception:
            total = len(pts)
        if pts and (all(y == 0 for _x, y in pts) or (total > 0 and len(pts) < 0.5 * total)):
            return failed
        n = len(pts)
        if n < 3:
            return failed
        # Weights: counts= turns the estimator into WLS. Weight scale is
        # irrelevant (a common factor cancels in slope and se) — only the
        # RELATIVE mass per period matters.
        ws = None
        if counts is not None:
            try:
                cs = [safe_float(c) for c in list(counts)]
                if len(cs) == total:
                    finite = sorted(c for c in cs if c is not None and c > 0)
                    if finite:
                        med_w = finite[len(finite) // 2]
                        ws = [cs[i] if (cs[i] is not None and cs[i] > 0) else med_w
                              for i, _ in pts]
            except Exception:
                ws = None
        weighted = ws is not None
        if ws is None:
            ws = [1.0] * n
        w_total = sum(ws)
        mean_x = sum(w * i for w, (i, _) in zip(ws, pts)) / w_total
        mean_y = sum(w * y for w, (_, y) in zip(ws, pts)) / w_total
        sxx = sum(w * (i - mean_x) ** 2 for w, (i, _) in zip(ws, pts))
        if sxx == 0:
            return failed
        slope = sum(w * (i - mean_x) * (y - mean_y) for w, (i, y) in zip(ws, pts)) / sxx
        intercept = mean_y - slope * mean_x
        sse = sum(w * (y - (intercept + slope * i)) ** 2 for w, (i, y) in zip(ws, pts))
        ci = None
        if sse <= 1e-30:  # perfect fit: zero residual variance, t undefined
            p = 0.0 if slope != 0 else 1.0
            ci = [slope, slope]
        else:
            se = math.sqrt(sse / (n - 2) / sxx)
            t = slope / se
            p = _t_p_two_sided(t, n - 2)
            crit = _t_crit_95(n - 2)  # exact t critical (not the df→∞ normal 1.96)
            ci = [slope - crit * se, slope + crit * se]
        direction = "flat" if p >= 0.05 else ("rising" if slope > 0 else "falling")
        out = {"direction": direction, "slope_per_period": slope, "p_value": p,
               "slope_ci95": ci, "n_zero_excluded": n_zx, "weighted": weighted}
        if unit is not None:
            out["unit"] = unit
        return out
    except Exception:
        return failed


def finding_step_change(values, labels=None, counts=None, unit=None):
    """Largest single-period level shift, if it stands out AND persists.

    Returns {"period", "delta", "direction", "baseline_spread"} where period
    is labels[i] (or index i) of the first value AFTER the jump, direction is
    "up"/"down" from delta's sign (bind THIS for narrative language — a
    negative delta narrated as an "acceleration" is the sign-blindness bug),
    and baseline_spread is the median absolute period-over-period delta.

    Three gates — failing any returns period/delta/direction None (with
    baseline_spread kept):
      - sample size (when counts= is given — observations per period): a
        step whose BEFORE or AFTER period is THIN (count < max(5, 20% of
        the median count)) is an artifact of sparse data, not structure —
        a -18.5 "structural break" off a 22-dish year cleared a 0.29
        spread trivially. ALWAYS pass counts when periods aggregate rows.
      - magnitude: |delta| must exceed 3x the baseline spread;
      - persistence: >= 70% of post-step values must stay on the new side of
        the pre/post midpoint. A step-change model asserts one regime
        REPLACED another; an oscillating series (a wave that re-crosses the
        break — e.g. a decline followed by a higher peak) is not a regime
        change, and fitting a break to a wave's downslope reports a
        structural inflection that does not exist.

    ALWAYS pass unit= for monetary measures: a trailing $0.00 sentinel
    year manufactures a full-magnitude down-step that PASSES all three
    gates (the single post point sits below the midpoint trivially, and
    counts= cannot save it — sentinel years are often well-attested rows
    of unpriced items). zero_policy runs internally; the screen is
    reported as n_zero_excluded. Never raises.
    """
    failed = {"detected": False, "period": None, "delta": None, "direction": None,
              "baseline_spread": None, "n_zero_excluded": None}
    try:
        if labels is not None and _ordinal_disorder(labels):
            return failed  # deltas over provably unordered x are undefined
        values, n_zx = _zero_screen(values, counts=counts, labels=labels, unit=unit)
        ys = [safe_float(v) for v in list(values)]
        deltas = [
            None if (ys[i - 1] is None or ys[i] is None) else ys[i] - ys[i - 1]
            for i in range(1, len(ys))
        ]
        spread = sorted(abs(d) for d in deltas if d is not None)
        if not spread:
            return failed
        m = len(spread)
        median = spread[m // 2] if m % 2 else (spread[m // 2 - 1] + spread[m // 2]) / 2.0
        # The looked-and-found-nothing result declares itself (spec
        # finding-field-roles-2026-08-13 §2.M3): "detected": False rides IN
        # the value, so it survives every copy/spread/serialization and the
        # projection withholds the secondary numbers. Run 77051c9d narrated
        # this dict's baseline_spread (118.97, a scale reference) as "the
        # sharpest jump between consecutive days" — a number the planner
        # should never have been offered.
        no_step = {"detected": False, "period": None, "delta": None, "direction": None,
                   "baseline_spread": median, "n_zero_excluded": n_zx}
        best_i, best_d = None, None
        for i, d in enumerate(deltas):
            if d is not None and (best_d is None or abs(d) > abs(best_d)):
                best_i, best_d = i, d
        if best_d is None or abs(best_d) <= 3.0 * median:
            return no_step
        idx = best_i + 1  # the period the level changed TO
        # Spike-reversion gate: a "step" whose BEFORE level is itself a
        # one-point outlier (far off the pre-period median) is a spike
        # reverting, not a regime change — 1999's outlier-driven $987.93
        # "stepping down" -977.9 in 2000 is the 1999 artifact, and two
        # regime-slope findings were fit on it. The before level must be
        # representative of its own regime.
        pre = [y for y in ys[:idx - 1] if y is not None][-12:]
        if len(pre) >= 3:
            sp = sorted(pre)
            pre_med = sp[len(sp) // 2]
            before_dev = abs((ys[idx - 1] or 0.0) - pre_med)
            if before_dev > 0.5 * abs(best_d) and before_dev > 3.0 * median:
                return no_step
        if counts is not None:
            try:
                ns = [safe_float(c) for c in list(counts)]
                finite_ns = sorted(n for n in ns if n is not None)
                if finite_ns and len(ns) == len(ys):
                    thin = _attestation_bar(finite_ns)
                    n_before = ns[idx - 1]
                    n_after = ns[idx]
                    if (n_before is not None and n_before < thin) or (
                        n_after is not None and n_after < thin
                    ):
                        return no_step
            except Exception:
                pass
        before = ys[idx - 1]
        midpoint = before + best_d / 2.0
        post = [y for y in ys[idx:] if y is not None]
        if post:
            if best_d > 0:
                held = sum(1 for y in post if y > midpoint)
            else:
                held = sum(1 for y in post if y < midpoint)
            if held / float(len(post)) < 0.7:
                return no_step
        period = idx
        if labels is not None:
            try:
                period = list(labels)[idx]
            except Exception:
                period = idx
        direction = "up" if best_d > 0 else "down"
        return {"period": period, "delta": best_d, "direction": direction,
                "baseline_spread": median, "n_zero_excluded": n_zx}
    except Exception:
        return failed


def finding_yoy(period_labels, values, unit=None):
    """Like-for-like year-over-year growth — the ONLY valid YoY on partial years.

    Comparing raw calendar-year totals when the latest year is incomplete
    (12 months vs 10) is invalid arithmetic dressed as a growth rate; this
    recurred repeatedly when hand-rolled. This helper restricts BOTH years
    to their overlapping months before comparing.

    period_labels: parseable period strings ("2021-03", "2021-03-15", ...);
    values are summed per (year, month). The two most recent years with any
    data are compared over the intersection of their reported months.

    Returns {"prior_year", "latest_year", "window_months", "prior_total",
    "latest_total", "pct_change", "n_zero_excluded"} — window_months is the
    sorted overlapping month list (e.g. [1..10]), recorded for audit.
    Degenerate inputs (fewer than two years, empty overlap, zero prior
    total) return all-None fields.

    ALWAYS pass unit= for monetary measures. Zeros are neutral in a SUM,
    but not in the WINDOW: a month whose only entries are sentinel zeros
    counted as a "reported" month and stayed in the like-for-like overlap.
    With unit= the screen (zero_policy, internal) nulls sentinel zeros, an
    all-sentinel month drops out of the totals, and the intersection then
    excludes it from BOTH years — unrecorded months cannot anchor a
    comparison. Reported as n_zero_excluded. Never raises.
    """
    failed = {"detected": False, "prior_year": None, "latest_year": None, "window_months": None,
              "prior_total": None, "latest_total": None, "pct_change": None,
              "n_zero_excluded": None}
    try:
        values, n_zx = _zero_screen(values, labels=period_labels, unit=unit)
        import re as _re
        totals = {}
        for label, v in zip(list(period_labels), list(values)):
            fv = safe_float(v)
            if fv is None:
                continue
            m = _re.search(r"(\d{4})\D?(\d{2})", str(label))
            if not m:
                continue
            y, mo = int(m.group(1)), int(m.group(2))
            if not 1 <= mo <= 12:
                continue
            totals[(y, mo)] = totals.get((y, mo), 0.0) + fv
        years = sorted({y for y, _ in totals})
        if len(years) < 2:
            return failed
        latest, prior = years[-1], years[-2]
        months = sorted(
            {mo for y, mo in totals if y == latest} & {mo for y, mo in totals if y == prior}
        )
        if not months:
            return failed
        prior_total = sum(totals[(prior, mo)] for mo in months)
        latest_total = sum(totals[(latest, mo)] for mo in months)
        if prior_total == 0:
            return {"prior_year": prior, "latest_year": latest, "window_months": months,
                    "prior_total": prior_total, "latest_total": latest_total,
                    "pct_change": None, "n_zero_excluded": n_zx}
        pct = (latest_total - prior_total) / abs(prior_total) * 100.0
        return {"prior_year": prior, "latest_year": latest, "window_months": months,
                "prior_total": prior_total, "latest_total": latest_total,
                "pct_change": round(pct, 1), "n_zero_excluded": n_zx}
    except Exception:
        return failed


def finding_outliers(labels, values, counts=None, window=21, k=3.5, unit=None):
    """Outlier screen — rolling MAD (a NAMED, established robust method).

    Retires the calibration-dial saga: MAD is scale-free (no 100x-vs-5x
    choice), tail-robust (an error cluster cannot raise its own bar — the
    failure that let $30,000 through a rolling-median baseline), and
    era-local via the window. Attestation protection is API-level: a value
    whose count >= max(5, 20% of the median count) is DATA, never an
    outlier, whatever its magnitude (the failure that deleted a
    1,217-listing $38 median). Pass counts ONLY for AGGREGATE series
    (medians/means — n attests the aggregate); for extreme statistics
    (max/min: a single observation regardless of year n) pass counts=None
    so magnitude alone decides.

    ALWAYS pass unit= for monetary measures: sentinel zeros (zero_policy,
    applied internally) are excluded BEFORE the MAD screen — a $0.00
    unrecorded-price row is a sentinel, not an outlier, and flagging it as
    one misreports an encoding as an anomaly. Reported as n_zero_excluded.

    Returns {"outliers": [{"label", "value", "z"}], "n_flagged", "method",
    "window", "k", "n_zero_excluded"}; degenerate input -> all-None fields.
    Never raises.
    """
    failed = {"detected": False, "outliers": None, "n_flagged": None, "method": "rolling_mad",
              "window": window, "k": k, "n_zero_excluded": None}
    try:
        if labels is not None and _ordinal_disorder(labels):
            return failed  # the era-local window is undefined over unordered x
        values, n_zx = _zero_screen(values, counts=counts, labels=labels, unit=unit)
        pts = []
        ns = list(counts) if counts is not None else None
        for i, (lab, v) in enumerate(zip(list(labels), list(values))):
            fv = safe_float(v)
            n = safe_float(ns[i]) if ns is not None and i < len(ns) else None
            pts.append((str(lab), fv, n))
        vals = [p[1] for p in pts if p[1] is not None]
        if len(vals) < 5:
            return failed
        finite_ns = sorted(p[2] for p in pts if p[2] is not None)
        thin_bar = _attestation_bar(finite_ns) if finite_ns else None

        def med(xs):
            s = sorted(xs)
            m = len(s)
            return s[m // 2] if m % 2 else (s[m // 2 - 1] + s[m // 2]) / 2.0

        half = max(2, window // 2)
        out = []
        idxs = [i for i, p in enumerate(pts) if p[1] is not None]
        for pos, i in enumerate(idxs):
            lab, v, n = pts[i]
            if thin_bar is not None and n is not None and n >= thin_bar:
                continue  # attestation protection: well-attested values are data
            neigh = [pts[j][1] for j in idxs[max(0, pos - half) : pos + half + 1] if j != i]
            if len(neigh) < 4:
                continue
            baseline = med(neigh)
            mad = med([abs(x - baseline) for x in neigh])
            if mad == 0:
                continue
            z = 0.6745 * (v - baseline) / mad
            if abs(z) > k:
                out.append({"label": lab, "value": v, "z": round(z, 1)})
        # A screen that flagged nothing DECLARES the non-detection (run
        # d82a39ce): with n_flagged bindable, the planner wrote "flagged 0
        # anomalous day(s)", the zero-narration policy dropped the sentence,
        # and the question's outlier component shipped unanswered. detected
        # False routes the claim through the non-detection channel — the
        # planner states "flagged no outliers" in words instead.
        result = {"outliers": out, "n_flagged": len(out), "method": "rolling_mad",
                  "window": window, "k": k, "n_zero_excluded": n_zx}
        if not out:
            result["detected"] = False
        return result
    except Exception:
        return failed


def finding_correlation(x_values, y_values, x_unit=None, y_unit=None):
    """Pearson + Spearman between two series (pairwise non-None).

    scipy supplies p-values when importable; the pure-Python fallback
    reports coefficients with p-values None — never a wrong p. Returns
    {"pearson_r", "pearson_p", "spearman_rho", "spearman_p", "n",
    "n_zero_excluded"}.

    ALWAYS pass x_unit=/y_unit= for monetary series (two inputs, so the
    unit is per axis): sentinel zeros in either series manufacture
    spurious correlation structure. zero_policy runs internally per axis;
    a screened member drops its PAIR (the existing pairwise-non-None
    rule), and n_zero_excluded counts zeros screened across both inputs.

    "preferred" is the select_center pattern applied to the coefficient
    choice: when either axis profiles TIED / HEAVY_TAIL / CONTAMINATED,
    the rank-based Spearman is the reliable coefficient and the function
    SAYS so — both are still reported (dispatch decides emphasis, never
    visibility). Never raises.
    """
    failed = {"detected": False, "pearson_r": None, "pearson_p": None, "spearman_rho": None,
              "spearman_p": None, "n": None, "preferred": None,
              "n_zero_excluded": None}
    try:
        x_values, n_zx_x = _zero_screen(x_values, unit=x_unit)
        y_values, n_zx_y = _zero_screen(y_values, unit=y_unit)
        n_zx = n_zx_x + n_zx_y
        pairs = [
            (safe_float(a), safe_float(b))
            for a, b in zip(list(x_values), list(y_values))
        ]
        pairs = [(a, b) for a, b in pairs if a is not None and b is not None]
        n = len(pairs)
        if n < 3:
            return failed
        xs = [a for a, _b in pairs]
        ys = [b for _a, b in pairs]
        preferred = "pearson"
        try:
            from .regimes import profile_regimes

            hazards = {"TIED", "HEAVY_TAIL", "CONTAMINATED"}
            fx = set(profile_regimes(xs).get("flags", []))
            fy = set(profile_regimes(ys).get("flags", []))
            if (fx | fy) & hazards:
                preferred = "spearman"
        except Exception:
            pass
        try:
            from scipy import stats as _st  # type: ignore

            pr = _st.pearsonr(xs, ys)
            sr = _st.spearmanr(xs, ys)
            return {"pearson_r": round(float(pr[0]), 4), "pearson_p": float(pr[1]),
                    "spearman_rho": round(float(sr[0]), 4), "spearman_p": float(sr[1]),
                    "n": n, "preferred": preferred, "n_zero_excluded": n_zx}
        except Exception:
            pass

        def _pearson(a, b):
            ma = sum(a) / len(a)
            mb = sum(b) / len(b)
            cov = sum((u - ma) * (w - mb) for u, w in zip(a, b))
            va = sum((u - ma) ** 2 for u in a) ** 0.5
            vb = sum((w - mb) ** 2 for w in b) ** 0.5
            return cov / (va * vb) if va and vb else None

        def _ranks(a):
            order = sorted(range(len(a)), key=lambda i: a[i])
            r = [0.0] * len(a)
            i = 0
            while i < len(order):
                j = i
                while j + 1 < len(order) and a[order[j + 1]] == a[order[i]]:
                    j += 1
                avg = (i + j) / 2.0 + 1
                for t in range(i, j + 1):
                    r[order[t]] = avg
                i = j + 1
            return r

        pear = _pearson(xs, ys)
        spear = _pearson(_ranks(xs), _ranks(ys))
        return {"pearson_r": None if pear is None else round(pear, 4), "pearson_p": None,
                "spearman_rho": None if spear is None else round(spear, 4),
                "spearman_p": None, "n": n, "preferred": preferred,
                "n_zero_excluded": n_zx}
    except Exception:
        return failed


def finding_distribution(values, unit=None):
    """Robust shape summary — the evidence behind a metric choice.

    Returns {"n", "mean", "median", "std", "mad", "skew", "p25", "p75",
    "min", "max", "distinct_share", "modal_share", "n_zero_excluded"}
    (skew = Fisher moment coefficient). A
    mean/median gap or a large skew is the COMPUTED justification for
    leading with the median. distinct_share/modal_share carry the
    DISCRETE/TIED evidence in the payload itself — quartiles over a
    low-cardinality measure collapse, and the caveat must be bindable, not
    asserted. ALWAYS pass unit= for monetary measures:
    sentinel zeros (zero_policy, applied internally) are excluded before
    the summary — a min of $0.00 from unrecorded prices is an encoding,
    not the distribution's floor. Never raises.
    """
    failed = {"detected": False, "n": None, "mean": None, "median": None, "std": None, "mad": None,
              "skew": None, "p25": None, "p75": None, "min": None, "max": None,
              "distinct_share": None, "modal_share": None,
              "n_zero_excluded": None}
    try:
        values, n_zx = _zero_screen(values, unit=unit)
        xs = sorted(v for v in (safe_float(x) for x in list(values)) if v is not None)
        n = len(xs)
        if n < 3:
            return failed

        def q(p):
            i = p * (n - 1)
            lo = int(i)
            hi = min(lo + 1, n - 1)
            return xs[lo] + (xs[hi] - xs[lo]) * (i - lo)

        median = q(0.5)
        np = numpy_or_none()
        if np is not None:
            # Vectorized aggregates (perf P6) — plain aggregations only, every
            # output rounded, so summation-order float differences cannot flip a
            # value. `mad` keeps the exact upper-middle (n//2) semantics of the
            # sorted-list index below (NOT np.median, which averages on even n).
            a = np.asarray(xs, dtype=float)
            mean = float(a.mean())
            var = float(((a - mean) ** 2).mean())
            std = var ** 0.5
            mad = float(np.sort(np.abs(a - median))[n // 2])
            skew = (float(((a - mean) ** 3).mean()) / (std ** 3)) if std else 0.0
            _u, _uc = np.unique(a, return_counts=True)
            distinct_n = len(_u)
            modal_n = int(_uc.max())
        else:
            mean = sum(xs) / n
            var = sum((x - mean) ** 2 for x in xs) / n
            std = var ** 0.5
            mad = sorted(abs(x - median) for x in xs)[n // 2]
            skew = (sum((x - mean) ** 3 for x in xs) / n) / (std ** 3) if std else 0.0
            # O(n) modal share (same fix as regimes.profile_regimes): the
            # max(set(xs), key=xs.count) form was O(n * distinct) — quadratic on
            # continuous measures where nearly every value is distinct.
            counts = {}
            for x in xs:
                counts[x] = counts.get(x, 0) + 1
            distinct_n = len(set(xs))
            modal_n = max(counts.values())
        return {"n": n, "mean": round(mean, 4), "median": round(median, 4),
                "std": round(std, 4), "mad": round(mad, 4), "skew": round(skew, 2),
                "p25": round(q(0.25), 4), "p75": round(q(0.75), 4),
                "min": xs[0], "max": xs[-1],
                "distinct_share": round(distinct_n / n, 3),
                "modal_share": round(modal_n / n, 3),
                "n_zero_excluded": n_zx}
    except Exception:
        return failed


def finding_share(parts, total=None):
    """Shares of a whole that MUST account for everything.

    parts is a dict of named contributions; total defaults to their sum.
    Returns {"shares_pct": {name: pct}, "residual_pct", "sums_to_100"} —
    narrated shares dropping the residual was the 58%+8.3% waterfall that
    didn't sum. Never raises.
    """
    failed = {"detected": False, "shares_pct": None, "residual_pct": None, "sums_to_100": None}
    try:
        clean = {str(k): safe_float(v) for k, v in dict(parts).items()}
        clean = {k: v for k, v in clean.items() if v is not None}
        if not clean:
            return failed
        tot = safe_float(total) if total is not None else sum(clean.values())
        if not tot:
            return failed
        shares = {k: round(v / tot * 100.0, 1) for k, v in clean.items()}
        residual = round(100.0 - sum(shares.values()), 1)
        return {"shares_pct": shares, "residual_pct": residual,
                "sums_to_100": abs(residual) < 1.0}
    except Exception:
        return failed


def finding_superlative(labels, values, counts=None, kind="max", unit=None):
    """Attestation-weighted superlative — the peak/trough among ADEQUATELY
    ATTESTED periods, with the raw extreme reported beside it.

    The calibration ladder's last rung: no multiplier constant can decide
    whether a 52-item year's $74 median outranks a 1,217-item year's $45 —
    dials are data-relative and every chosen dial has failed (100x let
    $30,000 pass; the same 100x crowned the 52-item year). The OBJECTIVE is
    pinned instead: a headline superlative must rest on a period with
    count >= max(5, 20% of the median count); the raw extreme over ALL
    periods is reported as raw_value/raw_period so nothing is hidden.

    ALWAYS pass unit= for monetary measures: sentinel zeros (zero_policy,
    applied internally) are excluded before the pick — a kind="min" trough
    of $0.00 from unrecorded prices is an encoding crowned as a price low.
    Reported as n_zero_excluded.

    Returns {"period", "value", "n", "raw_period", "raw_value", "raw_n",
    "thin_periods_skipped", "thin_bar", "n_zero_excluded"}; degenerate
    input all-None. Never raises.
    """
    failed = {"detected": False, "period": None, "value": None, "n": None, "raw_period": None,
              "raw_value": None, "raw_n": None, "thin_periods_skipped": None,
              "thin_bar": None, "bar_relaxed": None, "label_is_catchall": None,
              "n_zero_excluded": None}
    try:
        values, n_zx = _zero_screen(values, counts=counts, labels=labels, unit=unit)
        rows = []
        ns = list(counts) if counts is not None else None
        for i, (lab, v) in enumerate(zip(list(labels), list(values))):
            fv = safe_float(v)
            if fv is None:
                continue
            n = safe_float(ns[i]) if ns is not None and i < len(ns) else None
            rows.append((str(lab), fv, n))
        if not rows:
            return failed
        pick = max if kind != "min" else min
        raw = pick(rows, key=lambda r: r[1])
        finite_ns = sorted(r[2] for r in rows if r[2] is not None)
        thin = None
        if finite_ns:
            thin = _attestation_bar(finite_ns)
            attested = [r for r in rows if r[2] is None or r[2] >= thin]
        else:
            attested = rows
        skipped = len(rows) - len(attested)
        best = pick(attested, key=lambda r: r[1]) if attested else raw
        return {"period": best[0], "value": best[1], "n": best[2],
                "raw_period": raw[0], "raw_value": raw[1], "raw_n": raw[2],
                "thin_periods_skipped": skipped,
                "thin_bar": None if not finite_ns else round(thin, 1),
                "bar_relaxed": None if not finite_ns else bool(thin < _THIN_FLOOR),
                "label_is_catchall": _is_catchall_label(best[0]),
                "n_zero_excluded": n_zx}
    except Exception:
        return failed


def finding_split_comparison(labels, values, split_at=None, unit=None):
    """Early-vs-late comparison with the windowing scheme PINNED: midpoint
    split over the OBSERVED (non-None) series.

    Three consecutive runs used three windowing schemes (span-based,
    equal-n, midpoint) and produced multipliers of 7.9x, 34x, and 16.8x on
    the same data — a headline that moves 4x on an invisible convention.
    The midpoint split is the pinned scheme: it uses all the data and
    reports both n's and both spans so imbalance is visible, not silent.

    Pass the SAME series (same zero/outlier policy) the headline trend
    uses — feeding this a differently-screened series is the two-zero-
    policies bug. ALWAYS pass unit= for monetary measures: zero_policy
    runs internally (same screen as finding_trend), so passing the same
    unit to both makes one zero policy structural, not a convention.
    Returns {"early_median", "late_median", "early_n",
    "late_n", "early_span", "late_span", "multiplier", "n_zero_excluded"};
    degenerate input returns all-None. Never raises.
    """
    failed = {"detected": False, "early_median": None, "late_median": None, "early_n": None,
              "late_n": None, "early_span": None, "late_span": None,
              "multiplier": None, "n_zero_excluded": None}
    try:
        if labels is not None and _ordinal_disorder(labels):
            return failed  # an early/late split over unordered x is undefined
        values, n_zx = _zero_screen(values, labels=labels, unit=unit)
        pairs = [
            (str(lab), safe_float(v))
            for lab, v in zip(list(labels), list(values))
        ]
        pairs = [(lab, v) for lab, v in pairs if v is not None]
        if len(pairs) < 6:
            return failed
        if split_at is not None:
            # Shared split point: ALL split comparisons in a run must divide
            # at the SAME label — per-metric midpoints over differently-
            # screened subsets produced 1851-1952 vs 1851-1951 splits whose
            # multipliers are not comparable.
            sa = str(split_at)
            mid = next((i for i, (lab, _v) in enumerate(pairs) if lab >= sa), len(pairs) // 2)
        else:
            mid = len(pairs) // 2
        early, late = pairs[:mid], pairs[mid:]

        def med(vals):
            s = sorted(vals)
            n = len(s)
            return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0

        e_vals = [v for _l, v in early]
        l_vals = [v for _l, v in late]
        e_med, l_med = med(e_vals), med(l_vals)
        # A multiplier is only meaningful between POSITIVE levels: a zero or
        # signed median makes the ratio treacherous (negative/negative reads
        # as growth; positive/negative flips sign on a level convention).
        # Both levels are always reported — narrate those instead.
        mult = round(l_med / e_med, 1) if (e_med > 0 and l_med > 0) else None
        return {
            "early_median": e_med, "late_median": l_med,
            "early_n": len(early), "late_n": len(late),
            "early_span": "%s-%s" % (early[0][0], early[-1][0]),
            "late_span": "%s-%s" % (late[0][0], late[-1][0]),
            "multiplier": mult,
            "n_zero_excluded": n_zx,
        }
    except Exception:
        return failed


def finding_current_state(values, labels=None, window=6, coverage=None, counts=None,
                          unit=None):
    """Where the series ENDS — from the last COMPLETE observation.

    The trailing edge of a live dataset is often incomplete (reporting lag:
    the final day has a fraction of sources reported), and taking it at face
    value turns a truncation artifact into "the series collapsed 99.8%".

    Three completeness tests, walking back from the end:
      - coverage (SHARP, preferred): pass `coverage` — contributors per
        period (count of distinct reporting entities). A period whose
        coverage is < 50% of the max over the window before it is
        incomplete, regardless of its value. Magnitude dilutes under
        rollups (an incomplete month at 58% of trailing mean passes a
        value test); a 231 -> 3 reporting-entity drop is unambiguous.
      - attestation (SHARP): pass `counts` — observations per period. A
        trailing period under max(5, 20% of the prior periods' median
        count) is a thin tail, not a level change — the same bar
        finding_superlative applies (a 484-item final decade against a
        multi-thousand-median corpus narrated as "prices fell 50% from
        peak" is undigitized data, not a decline).
      - magnitude (fallback, always on): value < 30% of the trailing-window
        MEDIAN. Median, not mean (audited, run d82a39ce): one 871-dollar day
        in the window dragged the mean high enough to evict a normal-range
        final day (75.85 against a ~100 median), and the exclusion flipped
        the reported direction.

    Returns {"period", "value", "pct_from_peak", "peak_value", "peak_period",
    "direction", "excluded_trailing", "excluded_reason", "latest_period",
    "latest_value", "latest_n"} — period/value from the last
    complete observation, pct_from_peak vs the series max (negative below
    peak; when counts= is given the reference peak considers ATTESTED
    periods only, the same bar finding_superlative applies — an audited run
    reported -80% against an unattested 1851 banquet price while the
    attested-peak finding beside it said 0%: two peaks, one payload),
    direction the endpoint vs the median of the prior window, and
    excluded_trailing / excluded_reason how many tail observations the
    guards dropped and WHICH guard dominated ("attestation" | "coverage" |
    "magnitude"; None when nothing was excluded) — bind the reason in the
    caveat rather than inventing a mechanism.

    latest_* is the RAW final observation, reported unconditionally — the
    same raw-beside-attested symmetry finding_superlative has. A gate may
    decide what the headline EMPHASIZES, never what the reader can SEE: a
    reviewed run walked back 68 thin years and the $26/2012 endpoint
    vanished entirely, leaving "current state 1933 at $0.40" as the only
    story. Narrate both when they differ ("well-covered data ends {period};
    the latest raw observation is {latest_value} in {latest_period},
    n={latest_n}").

    ALWAYS pass unit= for monetary measures: sentinel zeros (zero_policy,
    applied internally) are treated as unrecorded — not observations — so
    a trailing $0.00 year can neither be the endpoint nor latest_*; the
    screen is reported as n_zero_excluded. Never raises.
    """
    failed = {"detected": False, "period": None, "value": None, "pct_from_peak": None,
              "peak_value": None, "peak_period": None,
              "direction": None, "excluded_trailing": None,
              "excluded_reason": None, "latest_period": None,
              "latest_value": None, "latest_n": None, "n_zero_excluded": None}
    try:
        if labels is not None and _ordinal_disorder(labels):
            return failed  # the walk-back assumes chronological order
        values, n_zx = _zero_screen(values, counts=counts, labels=labels, unit=unit)
        ys = [safe_float(v) for v in list(values)]
        covs = None
        if coverage is not None:
            try:
                covs = [safe_float(c) for c in list(coverage)]
                if len(covs) != len(ys):
                    covs = None
            except Exception:
                covs = None
        cnts = None
        if counts is not None:
            try:
                cnts = [safe_float(c) for c in list(counts)]
                if len(cnts) != len(ys):
                    cnts = None
            except Exception:
                cnts = None
        idxs = [i for i, y in enumerate(ys) if y is not None]
        if len(idxs) < 2:
            return failed
        end = idxs[-1]
        excluded = 0
        reasons = {"coverage": 0, "attestation": 0, "magnitude": 0}
        # Magnitude-ONLY exclusions are capped at 2: the 0.3x-trailing-mean
        # test assumes a roughly stationary level, and on a genuinely
        # DECLININING series it cascades — a run walked back 9 real years
        # (each with 100+ observations) and two metrics disagreed about
        # where the data ends. Deep walk-backs require coverage EVIDENCE.
        magnitude_only_cap = 2
        while True:
            prior_i = [i for i in idxs if i < end]
            prior = [ys[i] for i in prior_i][-window:]
            if len(prior) < 2:
                break
            incomplete = False
            reason = None
            if covs is not None:
                cov_prior = [covs[i] for i in prior_i if covs[i] is not None][-window:]
                cov_cur = covs[end]
                if cov_prior and cov_cur is not None and cov_cur < 0.5 * max(cov_prior):
                    incomplete = True
                    reason = "coverage"
            # Attestation: same thin bar as finding_superlative, against the
            # median count of ALL prior complete periods (not just the
            # window) — the corpus level is the reference, not the run-up.
            if not incomplete and cnts is not None:
                n_cur = cnts[end]
                prior_n = [cnts[i] for i in prior_i if cnts[i] is not None]
                bar = _attestation_bar(prior_n) if prior_n else None
                if bar is not None and n_cur is not None and n_cur < bar:
                    incomplete = True
                    reason = "attestation"
            sp_prior = sorted(prior)
            mid = len(sp_prior) // 2
            prior_med = (
                sp_prior[mid] if len(sp_prior) % 2 else (sp_prior[mid - 1] + sp_prior[mid]) / 2.0
            )
            cur = ys[end]
            if (
                not incomplete
                and covs is None
                and cnts is None
                and excluded >= magnitude_only_cap
            ):
                break
            if not incomplete and prior_med > 0 and cur is not None and cur < 0.3 * prior_med:
                incomplete = True
                reason = "magnitude"
            if incomplete:
                excluded += 1
                if reason is not None:
                    reasons[reason] += 1
                if not prior_i:
                    return failed
                end = prior_i[-1]
                continue
            break
        value = ys[end]
        # The reference peak is ATTESTATION-CONSISTENT: with counts provided,
        # only periods clearing the same bar finding_superlative uses may be
        # the peak — otherwise this finding and the superlative beside it
        # report two different peaks for one series.
        peak_idx = [i for i in idxs if i <= end]
        if cnts is not None:
            finite_n = [cnts[i] for i in peak_idx if cnts[i] is not None]
            bar = _attestation_bar(finite_n) if finite_n else None
            if bar is not None:
                attested_idx = [i for i in peak_idx if cnts[i] is None or cnts[i] >= bar]
                if attested_idx:
                    peak_idx = attested_idx
        finite_idx = [i for i in peak_idx if ys[i] is not None]
        if not finite_idx:
            finite_idx = [i for i in range(end + 1) if ys[i] is not None]
        peak_i = max(finite_idx, key=lambda i: ys[i])
        peak = ys[peak_i]
        # The peak the percentage is computed AGAINST rides in the value
        # (audit, run d82a39ce): pct_from_peak was unverifiable from the
        # claim alone — every figure a claim reports should carry the
        # evidence to check it.
        peak_period = peak_i
        if labels is not None:
            try:
                peak_period = list(labels)[peak_i]
            except Exception:
                peak_period = peak_i
        pct = None if peak == 0 else (value - peak) / abs(peak) * 100.0
        # Direction = where the ENDPOINT sits relative to the recent level
        # (median of the prior window) — NOT a tail OLS slope. A slope over
        # the last N points is dominated by the run-up and blind to an
        # endpoint collapse: a series whose final observation fell 77.6% YoY
        # was labeled "rising" (run-32), contradicting the yoy finding
        # beside it in the same payload.
        prior_tail = [ys[i] for i in idxs if i < end][-window:]
        direction = None
        if len(prior_tail) >= 2 and value is not None:
            sp = sorted(prior_tail)
            recent = sp[len(sp) // 2] if len(sp) % 2 else (sp[len(sp) // 2 - 1] + sp[len(sp) // 2]) / 2.0
            scale = max(abs(recent), abs(value)) or 1.0
            diff = value - recent
            if abs(diff) < 0.1 * scale:
                direction = "flat"
            else:
                direction = "rising" if diff > 0 else "falling"
        period = end
        if labels is not None:
            try:
                period = list(labels)[end]
            except Exception:
                period = end
        dominant = None
        if excluded > 0:
            dominant = max(reasons, key=lambda k: reasons[k])
            if reasons[dominant] == 0:
                dominant = None
        last = idxs[-1]
        latest_period = last
        if labels is not None:
            try:
                latest_period = list(labels)[last]
            except Exception:
                latest_period = last
        latest_n = None
        if cnts is not None and cnts[last] is not None:
            latest_n = cnts[last]
        return {"period": period, "value": value,
                "pct_from_peak": None if pct is None else round(pct, 2),
                "peak_value": peak, "peak_period": peak_period,
                "direction": direction, "excluded_trailing": excluded,
                "excluded_reason": dominant,
                "latest_period": latest_period, "latest_value": ys[last],
                "latest_n": latest_n, "n_zero_excluded": n_zx}
    except Exception:
        return failed


def finding_decompose(total_change, terms):
    """Attribution split → {**terms, "dominant": max-|term| key, "residual"}.

    residual = total_change - sum(terms) — a large residual means the declared
    terms do not actually explain the change they claim to. Never raises.
    """
    try:
        total = safe_float(total_change)
        clean = {str(k): safe_float(v) for k, v in dict(terms).items()}
        out = dict(clean)
        finite = {k: v for k, v in clean.items() if v is not None}
        out["dominant"] = max(finite, key=lambda k: abs(finite[k])) if finite else None
        out["residual"] = None if total is None else total - sum(finite.values())
        return out
    except Exception:
        return {"dominant": None, "residual": None}


def finding_heterogeneity(groups, unit=None):
    """Do the groups differ? → {"significant", "p_value", "test",
    "group_ns", "n_zero_excluded"}.

    significant = p < 0.05 that the groups differ. The TEST IS DISPATCHED
    from the pooled regime profile: under HEAVY_TAIL or CONTAMINATED the
    variance-based F is not a valid instrument (one $3,050 transcription
    error owns the within-group variance) and the rank-based
    Kruskal–Wallis runs instead — "test" reports which ran
    ("anova" | "kruskal_wallis"), the select_center pattern applied to the
    test statistic. scipy when importable, else pure-python with exact
    p-values (_anova_p / _kw_p). group_ns carries each usable group's n in
    the payload — a verdict over thin groups must be bindable as such,
    never asserted. Never raises → all-None fields when fewer than two
    usable groups or the test degenerates.

    ALWAYS pass unit= for monetary measures: sentinel zeros drag group
    means toward zero and inflate within-group variance — significance can
    flip either way. The zero policy is decided ONCE over the POOLED
    values (one policy per measure, never per group) and applied to every
    group; the screen is reported as n_zero_excluded.
    """
    failed = {"detected": False, "significant": None, "p_value": None, "test": "anova",
              "group_ns": None, "n_zero_excluded": None}
    try:
        norm = []
        for name, vals in dict(groups).items():
            try:
                norm.append((_safe_name(name), list(vals)))
            except Exception:
                continue
        n_zx = 0
        if unit is not None and norm:
            flat = [v for _n, vals in norm for v in vals]
            screened, n_zx = _zero_screen(flat, unit=unit)
            if n_zx:
                pos = 0
                for i, (name, vals) in enumerate(norm):
                    norm[i] = (name, screened[pos:pos + len(vals)])
                    pos += len(vals)
        samples = []
        group_ns = {}
        for name, vals in norm:
            clean = [f for f in (safe_float(v) for v in vals) if f is not None]
            if len(clean) >= 2:
                samples.append(clean)
                group_ns[name] = len(clean)
        if len(samples) < 2:
            return failed
        # Dispatch: heavy-tail regimes demote the variance-based F to ranks.
        test = "anova"
        try:
            from .regimes import profile_regimes

            pooled = [v for s in samples for v in s]
            flags = set(profile_regimes(pooled).get("flags", []))
            if "HEAVY_TAIL" in flags or "CONTAMINATED" in flags:
                test = "kruskal_wallis"
        except Exception:
            pass
        p = None
        if test == "kruskal_wallis":
            try:
                from scipy.stats import kruskal

                p = float(kruskal(*samples).pvalue)
                if p != p:
                    p = None
            except Exception:
                p = None
            if p is None:
                p = _kw_p(samples)
        else:
            try:
                from scipy.stats import f_oneway

                p = float(f_oneway(*samples).pvalue)
                if p != p:  # NaN (e.g. zero within-group variance) → fallback
                    p = None
            except Exception:
                p = None
            if p is None:
                p = _anova_p(samples)
        if p is None:
            return dict(failed, test=test, group_ns=group_ns)
        return {"significant": bool(p < 0.05), "p_value": p, "test": test,
                "group_ns": group_ns, "n_zero_excluded": n_zx}
    except Exception:
        return failed


def _anova_p(samples):
    # Pure-python one-way ANOVA p-value; None when degenerate.
    k = len(samples)
    n = sum(len(s) for s in samples)
    if n <= k:
        return None
    grand = sum(sum(s) for s in samples) / n
    means = [sum(s) / len(s) for s in samples]
    ss_between = sum(len(s) * (m - grand) ** 2 for s, m in zip(samples, means))
    ss_within = sum(sum((x - m) ** 2 for x in s) for s, m in zip(samples, means))
    if ss_within <= 0.0:
        return 0.0 if ss_between > 0.0 else None
    f_stat = (ss_between / (k - 1)) / (ss_within / (n - k))
    return _f_p(f_stat, k - 1, n - k)

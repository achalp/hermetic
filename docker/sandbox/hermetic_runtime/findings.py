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

from .coerce import safe_float, to_native

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

        frame = sys._getframe(1)
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


def _f_p(f_stat, df1, df2):
    # P(F_{df1,df2} >= f) — exact via I_x(df2/2, df1/2) at x = df2/(df2 + df1·f).
    return _betainc_reg(df2 / 2.0, df1 / 2.0, df2 / (df2 + df1 * f_stat))


def _clean_series(values):
    # (index, float) pairs with NaN/None dropped but ORIGINAL spacing kept —
    # a gap in the series must not compress the time axis under the slope.
    return [
        (i, f) for i, f in enumerate(safe_float(v) for v in list(values)) if f is not None
    ]


def finding_trend(values, unit=None):
    """Least-squares trend over an ordered series → direction/slope/p dict.

    Returns {"direction": "rising"|"falling"|"flat", "slope_per_period",
    "p_value"} (plus "unit" passthrough when given). "flat" means the slope's
    two-sided t-test p >= 0.05, not slope == 0. Never raises; a series too
    short or degenerate for inference → {"direction": None, ...}.
    """
    failed = {"direction": None, "slope_per_period": None, "p_value": None}
    try:
        pts = _clean_series(values)
        n = len(pts)
        if n < 3:
            return failed
        mean_x = sum(i for i, _ in pts) / n
        mean_y = sum(y for _, y in pts) / n
        sxx = sum((i - mean_x) ** 2 for i, _ in pts)
        if sxx == 0:
            return failed
        slope = sum((i - mean_x) * (y - mean_y) for i, y in pts) / sxx
        intercept = mean_y - slope * mean_x
        sse = sum((y - (intercept + slope * i)) ** 2 for i, y in pts)
        if sse <= 1e-30:  # perfect fit: zero residual variance, t undefined
            p = 0.0 if slope != 0 else 1.0
        else:
            t = slope / math.sqrt(sse / (n - 2) / sxx)
            p = _t_p_two_sided(t, n - 2)
        direction = "flat" if p >= 0.05 else ("rising" if slope > 0 else "falling")
        out = {"direction": direction, "slope_per_period": slope, "p_value": p}
        if unit is not None:
            out["unit"] = unit
        return out
    except Exception:
        return failed


def finding_step_change(values, labels=None, counts=None):
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
        structural inflection that does not exist. Never raises.
    """
    failed = {"period": None, "delta": None, "direction": None, "baseline_spread": None}
    try:
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
        no_step = {"period": None, "delta": None, "direction": None, "baseline_spread": median}
        best_i, best_d = None, None
        for i, d in enumerate(deltas):
            if d is not None and (best_d is None or abs(d) > abs(best_d)):
                best_i, best_d = i, d
        if best_d is None or abs(best_d) <= 3.0 * median:
            return no_step
        idx = best_i + 1  # the period the level changed TO
        if counts is not None:
            try:
                ns = [safe_float(c) for c in list(counts)]
                finite_ns = sorted(n for n in ns if n is not None)
                if finite_ns and len(ns) == len(ys):
                    med = finite_ns[len(finite_ns) // 2]
                    thin = max(5.0, 0.2 * med)
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
                "baseline_spread": median}
    except Exception:
        return failed


def finding_yoy(period_labels, values):
    """Like-for-like year-over-year growth — the ONLY valid YoY on partial years.

    Comparing raw calendar-year totals when the latest year is incomplete
    (12 months vs 10) is invalid arithmetic dressed as a growth rate; this
    recurred repeatedly when hand-rolled. This helper restricts BOTH years
    to their overlapping months before comparing.

    period_labels: parseable period strings ("2021-03", "2021-03-15", ...);
    values are summed per (year, month). The two most recent years with any
    data are compared over the intersection of their reported months.

    Returns {"prior_year", "latest_year", "window_months", "prior_total",
    "latest_total", "pct_change"} — window_months is the sorted overlapping
    month list (e.g. [1..10]), recorded for audit. Degenerate inputs
    (fewer than two years, empty overlap, zero prior total) return all-None
    fields. Never raises.
    """
    failed = {"prior_year": None, "latest_year": None, "window_months": None,
              "prior_total": None, "latest_total": None, "pct_change": None}
    try:
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
                    "pct_change": None}
        pct = (latest_total - prior_total) / abs(prior_total) * 100.0
        return {"prior_year": prior, "latest_year": latest, "window_months": months,
                "prior_total": prior_total, "latest_total": latest_total,
                "pct_change": round(pct, 1)}
    except Exception:
        return failed


def finding_current_state(values, labels=None, window=6, coverage=None):
    """Where the series ENDS — from the last COMPLETE observation.

    The trailing edge of a live dataset is often incomplete (reporting lag:
    the final day has a fraction of sources reported), and taking it at face
    value turns a truncation artifact into "the series collapsed 99.8%".

    Two completeness tests, walking back from the end:
      - coverage (SHARP, preferred): pass `coverage` — contributors per
        period (count of distinct reporting entities). A period whose
        coverage is < 50% of the max over the window before it is
        incomplete, regardless of its value. Magnitude dilutes under
        rollups (an incomplete month at 58% of trailing mean passes a
        value test); a 231 -> 3 reporting-entity drop is unambiguous.
      - magnitude (fallback, always on): value < 30% of the trailing-window
        mean.

    Returns {"period", "value", "pct_from_peak", "direction",
    "excluded_trailing"} — period/value from the last complete observation,
    pct_from_peak vs the series max (negative below peak), direction the
    sign of a least-squares slope over the final `window` complete points
    ("rising"/"falling"/"flat"), excluded_trailing how many tail
    observations the guards dropped (0 = clean edge). Never raises.
    """
    failed = {"period": None, "value": None, "pct_from_peak": None,
              "direction": None, "excluded_trailing": None}
    try:
        ys = [safe_float(v) for v in list(values)]
        covs = None
        if coverage is not None:
            try:
                covs = [safe_float(c) for c in list(coverage)]
                if len(covs) != len(ys):
                    covs = None
            except Exception:
                covs = None
        idxs = [i for i, y in enumerate(ys) if y is not None]
        if len(idxs) < 2:
            return failed
        end = idxs[-1]
        excluded = 0
        while True:
            prior_i = [i for i in idxs if i < end]
            prior = [ys[i] for i in prior_i][-window:]
            if len(prior) < 2:
                break
            incomplete = False
            if covs is not None:
                cov_prior = [covs[i] for i in prior_i if covs[i] is not None][-window:]
                cov_cur = covs[end]
                if cov_prior and cov_cur is not None and cov_cur < 0.5 * max(cov_prior):
                    incomplete = True
            mean = sum(prior) / len(prior)
            cur = ys[end]
            if not incomplete and mean > 0 and cur is not None and cur < 0.3 * mean:
                incomplete = True
            if incomplete:
                excluded += 1
                if not prior_i:
                    return failed
                end = prior_i[-1]
                continue
            break
        value = ys[end]
        finite = [y for y in ys[: end + 1] if y is not None]
        peak = max(finite)
        pct = None if peak == 0 else (value - peak) / abs(peak) * 100.0
        tail_idx = [i for i in idxs if i <= end][-window:]
        direction = None
        if len(tail_idx) >= 2:
            xs = list(range(len(tail_idx)))
            ts = [ys[i] for i in tail_idx]
            n = len(xs)
            mx = sum(xs) / n
            my = sum(ts) / n
            denom = sum((x - mx) ** 2 for x in xs)
            slope = sum((x - mx) * (t - my) for x, t in zip(xs, ts)) / denom if denom else 0.0
            scale = max(abs(t) for t in ts) or 1.0
            if abs(slope) < 0.01 * scale:
                direction = "flat"
            else:
                direction = "rising" if slope > 0 else "falling"
        period = end
        if labels is not None:
            try:
                period = list(labels)[end]
            except Exception:
                period = end
        return {"period": period, "value": value,
                "pct_from_peak": None if pct is None else round(pct, 2),
                "direction": direction, "excluded_trailing": excluded}
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


def finding_heterogeneity(groups):
    """One-way ANOVA across named groups → {"significant", "p_value", "test"}.

    significant = p < 0.05 that the group means differ. scipy's f_oneway when
    importable, else a pure-python F test with the exact p (same math). Never
    raises → {"significant": None, "p_value": None, "test": "anova"} when
    fewer than two usable groups or the test degenerates.
    """
    failed = {"significant": None, "p_value": None, "test": "anova"}
    try:
        samples = []
        for _name, vals in dict(groups).items():
            clean = [f for f in (safe_float(v) for v in list(vals)) if f is not None]
            if len(clean) >= 2:
                samples.append(clean)
        if len(samples) < 2:
            return failed
        p = None
        try:
            from scipy.stats import f_oneway

            p = float(f_oneway(*samples).pvalue)
            if p != p:  # NaN (e.g. zero within-group variance) → pure fallback
                p = None
        except Exception:
            p = None
        if p is None:
            p = _anova_p(samples)
        if p is None:
            return failed
        return {"significant": bool(p < 0.05), "p_value": p, "test": "anova"}
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

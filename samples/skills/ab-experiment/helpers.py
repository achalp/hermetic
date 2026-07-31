"""A/B experiment helpers — significance and uncertainty for rate comparisons."""

import math


def two_proportion_ztest(successes_a, n_a, successes_b, n_b):
    """Two-proportion z-test: returns {rate_a, rate_b, z, p_value} (two-sided).

    Pass DECIDED units only (one row per assigned user/session). Uses the
    pooled-variance normal approximation — fine at experiment sample sizes.
    """
    if not n_a or not n_b:
        return {"rate_a": None, "rate_b": None, "z": None, "p_value": None}
    pa, pb = successes_a / n_a, successes_b / n_b
    pooled = (successes_a + successes_b) / (n_a + n_b)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n_a + 1 / n_b))
    if se == 0:
        return {"rate_a": pa, "rate_b": pb, "z": 0.0, "p_value": 1.0}
    z = (pb - pa) / se
    # Two-sided p from the normal CDF (erfc avoids a scipy dependency).
    p = math.erfc(abs(z) / math.sqrt(2))
    return {"rate_a": pa, "rate_b": pb, "z": z, "p_value": p}


def lift_ci(successes_a, n_a, successes_b, n_b, confidence=0.95):
    """Absolute lift (rate_b - rate_a) with a normal-approximation CI: {lift, lo, hi}.

    Report the interval alongside the point estimate — an interval spanning 0
    means the data cannot call a winner at this confidence.
    """
    if not n_a or not n_b:
        return {"lift": None, "lo": None, "hi": None}
    pa, pb = successes_a / n_a, successes_b / n_b
    se = math.sqrt(pa * (1 - pa) / n_a + pb * (1 - pb) / n_b)
    # z for the two-sided confidence level (1.96 at 95%) via inverse erfc.
    zcrit = math.sqrt(2) * _erfcinv(1 - confidence)
    lift = pb - pa
    return {"lift": lift, "lo": lift - zcrit * se, "hi": lift + zcrit * se}


def _erfcinv(y):
    # Newton refinement of a rational seed — plenty for CI z-criticals.
    x = 1.0
    for _ in range(60):
        err = math.erfc(x) - y
        deriv = -2.0 / math.sqrt(math.pi) * math.exp(-x * x)
        step = err / deriv
        x -= step
        if abs(step) < 1e-12:
            break
    return x

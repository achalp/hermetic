"""Never-raises coercion helpers for display values and JSON output."""

import math


def to_native(o):
    """Recursively coerce numpy/pandas/Decimal/datetime values to JSON-safe natives.

    NaN/Inf become None; DataFrames become lists of record dicts; unknown types
    fall back to str(). Never raises.
    """
    try:
        import numpy as np
    except Exception:
        np = None
    import datetime as dt
    from decimal import Decimal

    if o is None:
        return None
    if isinstance(o, bool):
        return o
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, (str, int)):
        return o
    if np is not None and isinstance(o, np.generic):
        return to_native(o.item())
    if np is not None and isinstance(o, np.ndarray):
        return [to_native(x) for x in o.tolist()]
    if isinstance(o, Decimal):
        f = float(o)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(o, (dt.datetime, dt.date)):
        return o.isoformat()
    try:
        import pandas as pd

        if o is getattr(pd, "NaT", None):
            return None
        if isinstance(o, pd.Timestamp):
            return o.isoformat()
        if isinstance(o, pd.DataFrame):
            return [to_native(r) for r in o.to_dict(orient="records")]
        if isinstance(o, pd.Series):
            return to_native(o.to_dict())
    except Exception:
        pass
    if isinstance(o, dict):
        return {str(k): to_native(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [to_native(x) for x in o]
    try:
        return str(o)
    except Exception:
        return None


def safe_float(x, default=None):
    """Never-raises float coercion for display fields (heights, prices, ...).

    Returns default for None/NaN/Inf/blank/non-numeric instead of throwing —
    use instead of hand-rolling float(row[c])/np.isnan chains, which crash on
    None, strings, and numpy types.
    """
    if x is None:
        return default
    try:
        import numpy as np

        if isinstance(x, np.generic):
            x = x.item()
        if x is None:
            return default
    except Exception:
        pass
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return default if (math.isnan(f) or math.isinf(f)) else f


def safe_int(x, default=None):
    """Never-raises int coercion (via safe_float), for counts/floors/year fields."""
    f = safe_float(x, None)
    return default if f is None else int(f)

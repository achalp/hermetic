"""Never-raises coercion helpers for display values and JSON output."""

import math
import datetime as _dt
from decimal import Decimal as _Decimal

# Cached lazy resolvers (perf P5): safe_float/to_native are per-ELEMENT
# primitives — a planet-scale pass calls them 300k+ times, and each call used to
# execute `import numpy as np` (an IMPORT_NAME: sys.modules lookup + import-lock
# machinery, ~1µs) — seconds of pure interpreter overhead across the multiple
# full-array passes. Resolving ONCE into a module global keeps the documented
# lazy-import policy (nothing heavy loads at module import; sandbox startup is
# unchanged) while making the per-call cost a global read.
_np = None
_np_resolved = False
_pd = None
_pd_resolved = False


def _numpy():
    global _np, _np_resolved
    if not _np_resolved:
        try:
            import numpy

            _np = numpy
        except Exception:
            _np = None
        _np_resolved = True
    return _np


def _pandas():
    global _pd, _pd_resolved
    if not _pd_resolved:
        try:
            import pandas

            _pd = pandas
        except Exception:
            _pd = None
        _pd_resolved = True
    return _pd


def numpy_or_none():
    """Public cached-numpy accessor for sibling modules (perf P6)."""
    return _numpy()


def to_native(o):
    """Recursively coerce numpy/pandas/Decimal/datetime values to JSON-safe natives.

    NaN/Inf become None; DataFrames become lists of record dicts; unknown types
    fall back to str(). Never raises.
    """
    np = _numpy()

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
    if isinstance(o, _Decimal):
        f = float(o)
        return None if (math.isnan(f) or math.isinf(f)) else f
    if isinstance(o, (_dt.datetime, _dt.date)):
        # pd.NaT IS a datetime instance and reaches this branch before the
        # pandas block below — NaT != NaT (NaN semantics), so this catches it.
        return None if o != o else o.isoformat()
    pd = _pandas()
    if pd is not None:
        try:
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
    np = _numpy()
    if np is not None and isinstance(x, np.generic):
        x = x.item()
        if x is None:
            return default
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return default if (math.isnan(f) or math.isinf(f)) else f


def safe_int(x, default=None):
    """Never-raises int coercion (via safe_float), for counts/floors/year fields."""
    f = safe_float(x, None)
    return default if f is None else int(f)

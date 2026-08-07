"""Platform-owned data-edge profiling (structural fix, 2026-08-07).

The trailing-completeness test failed four consecutive runs while it lived
in generated code — every run a fresh model had to re-decide to compute
per-period coverage and wire it to the completeness guard. Edge
completeness is a DATA QUALITY property of the input, so the platform
computes it deterministically at load time: the prelude's pandas/duckdb
load hooks call maybe_profile(df); write_output ships the result in the
envelope as `data_completeness` with zero generated-code involvement.

Never raises; profiling failure means the envelope simply lacks the block.
"""

_PROFILE = None
_EDGE_LIST_CAP = 10
_WINDOW = 14


def reset_profile():
    global _PROFILE
    _PROFILE = None


def get_profile():
    return _PROFILE


def maybe_profile(df):
    """Profile the first frame that yields a usable time column. Never raises."""
    global _PROFILE
    try:
        if _PROFILE is not None:
            return
        prof = profile_data_edges(df)
        if prof is not None:
            _PROFILE = prof
    except Exception:
        pass


def profile_data_edges(df):
    """Coverage-per-finest-period edge analysis of a raw frame.

    Detects a time column (best datetime-parse rate) and an entity/grouping
    column (highest-cardinality non-numeric), computes contributors per day
    (count of distinct entities; row counts when no entity column), then
    walks both edges: a period whose coverage is < 50% of the max over the
    adjacent 14-period window is incomplete (the 231 -> 3 reporting-country
    collapse a monthly rollup erases). Returns None when no time column
    qualifies; otherwise a small dict — empty edge lists mean "profiled,
    edges clean".
    """
    try:
        import pandas as pd

        if df is None or getattr(df, "empty", True) or len(df) < 30:
            return None
        best_parsed, best_col, best_n = None, None, 0
        for col in df.columns:
            s = df[col]
            kind = getattr(s.dtype, "kind", "")
            if kind in ("M",):
                parsed = s
            elif kind == "O" or str(s.dtype).startswith("string"):
                try:
                    parsed = pd.to_datetime(s, errors="coerce", format="mixed")
                except (TypeError, ValueError):
                    try:
                        parsed = pd.to_datetime(s, errors="coerce")
                    except Exception:
                        continue
            else:
                continue
            ok = parsed.notna()
            if len(s) == 0 or ok.mean() < 0.8:
                continue
            n = parsed[ok].nunique()
            if n >= 10 and n > best_n:
                best_parsed, best_col, best_n = parsed, col, n
        if best_col is None:
            return None
        dates = best_parsed.dt.normalize()

        ent_col, ent_card = None, 1
        for col in df.columns:
            if col == best_col:
                continue
            s = df[col]
            if getattr(s.dtype, "kind", "") == "O" or str(s.dtype).startswith(
                ("string", "category")
            ):
                try:
                    c = int(s.nunique())
                except Exception:
                    continue
                if c > ent_card:
                    ent_card, ent_col = c, col

        if ent_col is not None:
            cov = df.groupby(dates)[ent_col].nunique()
        else:
            cov = dates.value_counts()
        cov = cov.sort_index()
        vals = [float(x) for x in cov.values]
        labels = [str(getattr(i, "date", lambda: i)()) for i in cov.index]
        if len(vals) < _WINDOW + 2:
            return None

        trailing = []
        end = len(vals) - 1
        while end > _WINDOW and len(trailing) < _EDGE_LIST_CAP:
            prior = vals[max(0, end - _WINDOW) : end]
            base = max(prior) if prior else 0.0
            if base > 0 and vals[end] < 0.5 * base:
                trailing.append(
                    {"period": labels[end], "coverage": vals[end], "baseline_coverage": base}
                )
                end -= 1
            else:
                break
        trailing.reverse()

        leading = []
        start = 0
        while start < len(vals) - _WINDOW and len(leading) < _EDGE_LIST_CAP:
            nxt = vals[start + 1 : start + 1 + _WINDOW]
            base = max(nxt) if nxt else 0.0
            if base > 0 and vals[start] < 0.5 * base:
                leading.append(
                    {"period": labels[start], "coverage": vals[start], "baseline_coverage": base}
                )
                start += 1
            else:
                break

        return {
            "time_column": str(best_col),
            "entity_column": None if ent_col is None else str(ent_col),
            "grain": "day",
            "periods": len(vals),
            "coverage_max": max(vals),
            "trailing_incomplete": trailing,
            "leading_incomplete": leading,
        }
    except Exception:
        return None

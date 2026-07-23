"""Pandas-facing helpers: numeric coercion of Series/frames and crash-proof qcut."""


def to_num(s):
    """Coerce a Series/sequence to numeric, stripping currency symbols/commas/percent."""
    import pandas as pd

    ser = s if isinstance(s, pd.Series) else pd.Series(s)
    if ser.dtype.kind in "biufc":
        return pd.to_numeric(ser, errors="coerce")
    cleaned = (
        ser.astype(str)
        .str.replace(",", "", regex=False)
        .str.replace("$", "", regex=False)
        .str.replace("%", "", regex=False)
        .str.strip()
    )
    return pd.to_numeric(cleaned, errors="coerce")


def numeric(df, cols=None):
    """Numeric-only view of df (coerced) — safe for diff/corr/arithmetic."""
    import pandas as pd

    if cols is None:
        return df.apply(lambda c: pd.to_numeric(c, errors="coerce")).select_dtypes(
            include="number"
        )
    return pd.DataFrame({c: to_num(df[c]) for c in cols})


def safe_qcut(s, q, labels=None):
    """qcut that won't crash on skewed / low-cardinality columns.

    Drops duplicate bin edges and falls back to fewer bins or a rank-based split.
    """
    import pandas as pd

    ser = to_num(s)
    nun = int(ser.dropna().nunique())
    if nun < 2:
        return pd.Series(["all"] * len(ser), index=ser.index)
    k = q if isinstance(q, int) else len(q) - 1
    k = max(1, min(k, nun))
    lab = labels if (labels is None or len(labels) == k) else None
    try:
        return pd.qcut(ser, k, labels=lab, duplicates="drop")
    except Exception:
        try:
            return pd.qcut(ser.rank(method="first"), k, labels=lab, duplicates="drop")
        except Exception:
            return pd.cut(ser, min(k, 2), duplicates="drop")

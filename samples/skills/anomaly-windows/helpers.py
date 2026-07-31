"""Anomaly-detection helpers — robust scoring over small aggregated series."""


def mad_zscores(series):
    """Robust z-scores via median absolute deviation (0.6745*(x-med)/MAD).

    Use on an AGGREGATED series (one row per time bucket). Unlike mean/std
    z-scores, one huge spike cannot inflate the scale and mask the others.
    Returns a pandas Series aligned to the input; all-zero MAD yields zeros.
    """
    import pandas as pd

    s = pd.to_numeric(pd.Series(series), errors="coerce")
    med = s.median()
    mad = (s - med).abs().median()
    if not mad:
        return s * 0.0
    return 0.6745 * (s - med) / mad


def anomalous_windows(df, value_col, ts_col, threshold=3.5):
    """Rows whose |MAD z-score| exceeds threshold, with expected level + deviation.

    Input must already be one row per time bucket (aggregate in DuckDB first).
    Returns a copy with z, expected (median), and is_anomaly columns — bind
    the FULL frame to the chart and tag by is_anomaly so anomalies render in
    context.
    """
    out = df.copy()
    out["z"] = mad_zscores(out[value_col])
    out["expected"] = out[value_col].median()
    out["is_anomaly"] = out["z"].abs() > threshold
    return out.sort_values(ts_col).reset_index(drop=True)

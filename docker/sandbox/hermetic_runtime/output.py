"""write_output — the ONE way generated code should emit its results."""

from .coerce import to_native


def write_output(results=None, chart_data=None, datasets=None, images=None):
    """Write /data/output.json in the required envelope structure.

    Coerces NaN/Inf/numpy/Timestamp/Decimal to JSON-safe values and caps each
    dataset at 5000 rows (recording the true total for 'main' so the dashboard
    can disclose sampling). Always writes all four top-level keys.
    """
    out = {
        "results": to_native(results if results is not None else {}),
        "chart_data": to_native(chart_data if chart_data is not None else {}),
        "datasets": {},
        "images": to_native(images if images is not None else {}),
    }
    try:
        import pandas as pd
    except Exception:
        pd = None
    for k, v in (datasets or {}).items():
        total = None
        if pd is not None and isinstance(v, pd.DataFrame):
            total = int(len(v))
            v = v.head(5000).to_dict(orient="records")
        elif isinstance(v, list):
            total = len(v)
            v = v[:5000]
        if str(k) == "main" and total is not None and total > 5000:
            out["results"]["_main_total"] = total
        out["datasets"][str(k)] = to_native(v)
    import json

    with open("/data/output.json", "w") as f:
        json.dump(out, f, default=str, allow_nan=False)
    return out

"""write_output — the ONE way generated code should emit its results."""

from .coerce import to_native
from .findings import get_findings
from .profile import get_profile
from .series import get_series, get_values

_SCALAR = (int, float, str, bool, type(None))


def _synthesize(results, chart_data, series, values, findings):
    """Project the structured Analysis Product into the legacy views
    (specs/analysis-product-2026-08-08.md §1): chart_data[series.id] from each
    series' rows, values + fact-field auto-mirrors into results. Computed in
    exactly one place so the views can never diverge from the declarations —
    a declared series wins a chart_data key collision, an authored result key
    wins over a mirror (back-compat)."""
    for s in series:
        chart_data[s["id"]] = s["rows"]
    for v in values:
        results.setdefault(v["key"], v["value"])
    for f in findings:
        name = f.get("name") if isinstance(f, dict) else None
        if not isinstance(name, str):
            continue
        val = f.get("value")
        if isinstance(val, dict):
            for field, fv in val.items():
                if isinstance(fv, _SCALAR):
                    results.setdefault("%s_%s" % (name, field), fv)
        elif isinstance(val, _SCALAR):
            results.setdefault(name, val)


def write_output(results=None, chart_data=None, datasets=None, images=None, findings=None):
    """Write /data/output.json in the required envelope structure.

    Coerces NaN/Inf/numpy/Timestamp/Decimal to JSON-safe values and caps each
    dataset at 5000 rows (recording the true total for 'main' so the dashboard
    can disclose sampling). Always writes all top-level keys. The findings,
    series and values keys need NO arguments — the declare_* registries are
    the truth (declared-findings spec §2.1, analysis-product spec §1);
    findings= exists only as an explicit override. The legacy views are
    synthesized from the registries (see _synthesize). Entries were coerced at
    declaration time; the to_native here is belt-and-braces.
    """
    series = to_native(get_series())
    values = to_native(get_values())
    findings_out = to_native(findings if findings is not None else get_findings())
    out = {
        "results": to_native(results if results is not None else {}),
        "chart_data": to_native(chart_data if chart_data is not None else {}),
        "datasets": {},
        "images": to_native(images if images is not None else {}),
        "findings": findings_out,
        "series": series,
        "values": values,
        "data_completeness": to_native(get_profile()),
    }
    _synthesize(out["results"], out["chart_data"], series, values, findings_out)
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

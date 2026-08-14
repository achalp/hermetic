"""declare_series / declare_value — the structured Analysis Product layer
(specs/analysis-product-2026-08-08.md §1).

The producer side of the v2 envelope: generated code declares tidy series
with ROLES (which column is x, which are measures, which attests counts) and
standalone values with mandatory context, instead of hand-assembling display
dicts whose relationships the host had to re-infer from string conventions.

`write_output` synthesizes the legacy views (chart_data from series rows,
values into results) so the binding grammar downstream never changes — the
declarations here are the single source of truth, the flat namespaces become
projections.

Everything is never-raise (repo convention: a metadata feature must never
kill an analysis). Invalid declarations are dropped with a sidecar
diagnostic, mirroring the findings registry.
"""

from .coerce import to_native
from .findings import _safe_name, _sidecar_write

_series_registry = []
_values_registry = []

X_KINDS = ("temporal", "ordinal", "categorical")
ROWS_CAP = 5000

# Series-kind row contracts (specs/compiled-view-parity-2026-08-13.md §4):
# each kind pins the columns its rows MUST carry — each inner list is one
# required slot, satisfied by any of its aliases. "axis" (the default) has
# no extra requirements beyond x + measures. Mirrored at
# src/lib/product/series-kind-contract.json for the host's licensing layer;
# test_runtime asserts the two stay identical. An unknown kind or a missing
# contract column REJECTS the declaration with the exact gap named — never
# a silent axis fallback (spec review R3).
SERIES_KIND_CONTRACT = {
    "axis": [],
    "geo": [["lat", "latitude"], ["lng", "lon", "longitude"]],
    "distribution": [],  # the value column is the declared measure
    "hierarchy": [["parent", "path"], ["child", "name", "label"], ["value"]],
    "flow": [["source"], ["target"], ["weight", "value"]],
    "matrix": [["row"], ["col"], ["value"]],
    "curve": [["x"], ["y"]],
    "ohlc": [["open"], ["high"], ["low"], ["close"]],
    "span": [["label", "name"], ["start"], ["end"]],
    "vector": [["x"], ["y"], ["angle", "u"], ["magnitude", "v"]],
}


def get_series():
    """Snapshot of this run's declared series, in declaration order."""
    return list(_series_registry)


def get_values():
    """Snapshot of this run's declared values, in declaration order."""
    return list(_values_registry)


def reset_product():
    """Test hook: clear the series/values registries."""
    del _series_registry[:]
    del _values_registry[:]


def _dropped(kind, name, reason):
    _sidecar_write({"__dropped__": True, kind: _safe_name(name), "reason": reason})
    return None


def _as_role(spec):
    # Accept {"column": c, ...}, (column, kind), or a bare column string.
    if isinstance(spec, dict):
        return dict(spec)
    if isinstance(spec, (tuple, list)) and len(spec) == 2:
        return {"column": spec[0], "kind": spec[1]}
    if isinstance(spec, str):
        return {"column": spec}
    return None


_MEASURE_FIELDS = ("column", "unit", "of", "screened_by", "variant_of")

# How a measure re-aggregates from the raw table (analysis-product §1.4).
# A declared series ships ALREADY-AGGREGATED rows; nothing in them says how
# they were built, so the host cannot rebuild the measure for a filtered
# subset without guessing — and the natural guess is wrong for a ratio
# (averaging per-group rates is not the pooled rate). Declaring the recipe
# is what makes deterministic client-side filtering honest: the host replays
# it at the unfiltered baseline and refuses the recipe unless it reproduces
# these very rows.
_AGG_FNS = ("sum", "avg", "min", "max", "count", "ratio")


def _as_aggregates(spec, measure_column):
    """Normalize an `aggregates` role, or None when absent/invalid.

    {"fn": "sum"|"avg"|"min"|"max"|"count", "column"?: <source column>,
     "from"?: <dataset key>}
    {"fn": "ratio", "numerator": <col>, "denominator": <col>,
     "from"?: <dataset key>}
    """
    if not isinstance(spec, dict):
        return None
    fn = spec.get("fn")
    if fn not in _AGG_FNS:
        return None
    out = {"fn": fn, "from": spec.get("from") if isinstance(spec.get("from"), str) else "main"}
    if fn == "ratio":
        num, den = spec.get("numerator"), spec.get("denominator")
        if not isinstance(num, str) or not isinstance(den, str):
            return None
        out["numerator"], out["denominator"] = num, den
    else:
        col = spec.get("column")
        out["column"] = col if isinstance(col, str) else measure_column
    return out


def declare_series(series_id, rows, x, measures, count=None, group=None, kind=None):
    """Declare a tidy series with roles; write_output emits it (and its
    synthesized chart_data view) automatically.

    rows      DataFrame or list of row dicts — one observation per row.
    x         {"column": ..., "kind": "temporal"|"ordinal"|"categorical"}
              (a (column, kind) tuple also works).
    kind      the series SHAPE (default "axis"): "geo" (rows carry lat +
              lng/lon — licenses map views), "distribution" (rows are raw
              values of the measure — licenses histogram/box/violin),
              "hierarchy" (parent+child+value), "flow"
              (source+target+weight), "matrix" (row+col+value), "curve"
              (x+y[, lo/hi]), "ohlc", "span" (label+start+end), "vector".
              A kind whose contract columns are missing from the rows is
              REJECTED with the gap named — declare the columns, never
              rely on a fallback.
    measures  list of measure roles: {"column": ..., "unit"?: ...,
              "of"?: finding_name, "screened_by"?: check_name,
              "variant_of"?: other_measure_column,
              "aggregates"?: how the measure rebuilds from the raw table
              — {"fn": "sum"|"avg"|"min"|"max"|"count", "column"?: src,
              "from"?: dataset key} or {"fn": "ratio", "numerator": col,
              "denominator": col, "from"?: dataset key}} — a bare column
              string means an undecorated measure.
    count     attestation column name (observations behind each row), if any.
    group     category column name for grouped/faceted series, if any.

    Never raises. An invalid declaration (bad kind, column absent from the
    rows) is dropped with a sidecar diagnostic and returns None.
    """
    try:
        sid = _safe_name(series_id)
        try:
            import pandas as pd

            if isinstance(rows, pd.DataFrame):
                rows = rows.to_dict(orient="records")
        except Exception:
            pass
        if not isinstance(rows, list):
            return _dropped("series", sid, "rows must be a DataFrame or list of dicts")
        total = len(rows)
        rows = to_native(rows[:ROWS_CAP])
        columns = set()
        for r in rows:
            if isinstance(r, dict):
                columns.update(r.keys())

        skind = "axis" if kind is None else str(kind)
        if skind not in SERIES_KIND_CONTRACT:
            return _dropped(
                "series",
                sid,
                "unknown series kind '%s' — one of %s" % (skind, sorted(SERIES_KIND_CONTRACT)),
            )
        if rows:
            lowered = {c.lower() for c in columns}
            for slot in SERIES_KIND_CONTRACT[skind]:
                if not any(alias in lowered for alias in slot):
                    return _dropped(
                        "series",
                        sid,
                        "kind '%s' requires a column named one of %s in the rows"
                        % (skind, "/".join(slot)),
                    )

        xr = _as_role(x)
        if not xr or not isinstance(xr.get("column"), str):
            return _dropped("series", sid, "x role needs a column")
        if xr.get("kind") not in X_KINDS:
            return _dropped("series", sid, "x.kind must be one of %s" % (X_KINDS,))
        if rows and xr["column"] not in columns:
            return _dropped("series", sid, "x column '%s' not in rows" % xr["column"])

        ms = []
        for m in measures if isinstance(measures, (list, tuple)) else [measures]:
            mr = _as_role(m)
            if not mr or not isinstance(mr.get("column"), str):
                _dropped("series_measure", sid, "measure needs a column")
                continue
            if rows and mr["column"] not in columns:
                _dropped("series_measure", sid, "measure column '%s' not in rows" % mr["column"])
                continue
            role = {k: mr[k] for k in _MEASURE_FIELDS if isinstance(mr.get(k), str)}
            if "aggregates" in mr:
                agg = _as_aggregates(mr["aggregates"], mr["column"])
                if agg is None:
                    _dropped(
                        "series_measure",
                        sid,
                        "measure '%s' has an invalid aggregates role (fn must be one of %s; "
                        "ratio needs numerator= and denominator=)" % (mr["column"], _AGG_FNS),
                    )
                else:
                    role["aggregates"] = agg
            ms.append(role)
        if not ms:
            return _dropped("series", sid, "no valid measures")

        roles = {"x": {"column": xr["column"], "kind": xr["kind"]}, "measures": ms}
        for role_name, col in (("count", count), ("group", group)):
            if col is None:
                continue
            cr = _as_role(col)
            if not cr or not isinstance(cr.get("column"), str):
                _dropped("series_role", sid, "%s role needs a column" % role_name)
                continue
            if rows and cr["column"] not in columns:
                _dropped("series_role", sid, "%s column '%s' not in rows" % (role_name, cr["column"]))
                continue
            roles[role_name] = {"column": cr["column"]}

        entry = {"id": sid, "rows": rows, "roles": roles}
        if skind != "axis":
            entry["kind"] = skind
        if total > ROWS_CAP:
            entry["rows_total"] = total
        _series_registry.append(entry)
        return entry
    except Exception as err:
        try:
            return _dropped("series", series_id, "internal: %s" % err)
        except Exception:
            return None


def declare_value(key, value, label=None, unit=None, of=None):
    """Declare a standalone scalar for the results namespace.

    Context is mandatory (spec §1): pass `of="finding.field"` when the value
    restates a declared finding's field, else a human `label` describing what
    it is. A dict/list value is not a scalar and is dropped.
    Never raises; returns the entry, or None when dropped.
    """
    try:
        k = _safe_name(key)
        if isinstance(value, (dict, list, tuple, set)):
            return _dropped("value", k, "value must be a scalar")
        if not isinstance(of, str) and not isinstance(label, str):
            return _dropped("value", k, "needs of= (finding.field) or label= context")
        entry = {"key": k, "value": to_native(value)}
        for fk, fv in (("label", label), ("unit", unit), ("of", of)):
            if isinstance(fv, str):
                entry[fk] = fv
        _values_registry.append(entry)
        return entry
    except Exception as err:
        try:
            return _dropped("value", key, "internal: %s" % err)
        except Exception:
            return None

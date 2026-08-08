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


def declare_series(series_id, rows, x, measures, count=None, group=None):
    """Declare a tidy series with roles; write_output emits it (and its
    synthesized chart_data view) automatically.

    rows      DataFrame or list of row dicts — one observation per row.
    x         {"column": ..., "kind": "temporal"|"ordinal"|"categorical"}
              (a (column, kind) tuple also works).
    measures  list of measure roles: {"column": ..., "unit"?: ...,
              "of"?: finding_name, "screened_by"?: check_name,
              "variant_of"?: other_measure_column} — a bare column string
              means an undecorated measure.
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
            ms.append({k: mr[k] for k in _MEASURE_FIELDS if isinstance(mr.get(k), str)})
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

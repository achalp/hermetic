
import json as _json_mod
_orig_dump = _json_mod.dump
_orig_dumps = _json_mod.dumps
def _safe_dump(*a, **kw):
    kw['allow_nan'] = True
    return _orig_dump(*a, **kw)
def _safe_dumps(*a, **kw):
    kw['allow_nan'] = True
    return _orig_dumps(*a, **kw)
_json_mod.dump = _safe_dump
_json_mod.dumps = _safe_dumps

# ── Live progress (auto-injected) ────────────────────────────────────────────
# progress(phase, detail, **fields) prints a {"__progress": {...}} JSONL line to
# stdout; the server streams it to the UI. A daemon thread re-emits the current
# phase + elapsed every few seconds, so even a long SILENT scan shows "still
# running, 12m" — progress is guaranteed regardless of what the analysis code
# prints. Call progress("scanning California buildings") at phase boundaries;
# pass fraction=0..1 or rows=/total_rows= when you can (e.g. a DuckDB scan).
import sys as _sys, time as _time, threading as _threading
_hb = {"phase": "starting", "detail": None, "started": _time.time()}
def progress(phase=None, detail=None, **fields):
    if phase is not None: _hb["phase"] = phase
    if detail is not None: _hb["detail"] = detail
    p = {"phase": _hb["phase"], "elapsed_ms": int((_time.time() - _hb["started"]) * 1000)}
    if _hb["detail"] is not None: p["detail"] = _hb["detail"]
    for _k, _v in fields.items(): p[_k] = _v
    try:
        _sys.stdout.write(_json_mod.dumps({"__progress": p}) + "\\n"); _sys.stdout.flush()
    except Exception:
        pass
def _hb_loop():
    while True:
        _time.sleep(5)
        try: progress()
        except Exception: pass
_threading.Thread(target=_hb_loop, daemon=True).start()
progress("starting")

# ── Memory guard (auto-injected) ─────────────────────────────────────────────
# The container has a HARD memory cap (cgroup). The kernel OOM-killer only fires
# at 100%, AFTER the process has spent minutes ballooning — so a doomed approach
# (e.g. pulling 100M+ coordinates into a KD-tree) burns 20-30 min before dying
# with no useful signal, and the retry then repeats it. Two guards fix that:
#   • assert_fits(n_rows, ...) — an a-priori gate you call BEFORE a large .df().
#   • a background watchdog that fast-fails at ~90% of the cap.
# Both raise/exit with the SAME message: at this scale, stop retrying the direct
# in-memory approach and switch to the DOESN'T-FIT counting strategy.
import os as _os
def _mem_limit_bytes():
    for _p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(_p) as _f:
                _v = _f.read().strip()
            if _v and _v != "max":
                _b = int(_v)
                if 0 < _b < (1 << 62):  # v1 "unlimited" is a huge sentinel
                    return _b
        except Exception:
            pass
    try:
        _mb = float(_os.environ.get("HERMETIC_MEM_LIMIT_MB", ""))
        if _mb > 0:
            return int(_mb * 1024 * 1024)
    except Exception:
        pass
    return None

def _mem_usage_bytes():
    for _p in ("/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        try:
            with open(_p) as _f:
                return int(_f.read().strip())
        except Exception:
            pass
    try:
        with open("/proc/self/statm") as _f:
            return int(_f.read().split()[1]) * _os.sysconf("SC_PAGE_SIZE")
    except Exception:
        return 0

_MEM_LIMIT = _mem_limit_bytes()
_INFEASIBLE_MSG = (
    "This approach does not fit the container memory cap ({limit}). You are pulling too "
    "many rows into pandas. Do NOT retry the direct in-memory approach with fewer columns "
    "— at this scale even coordinates-only does NOT fit (cKDTree.query also allocates two "
    "more N-sized arrays). SWITCH STRATEGY: COUNT in DuckDB and go coarse-to-fine — bucket "
    "rows into grid cells with GROUP BY (nothing lands in pandas), branch-and-bound on the "
    "small cells table, then pull ONLY the tiny survivor set. Follow the PLANET-SCALE / "
    "DOESN'T-FIT recipe; do not materialize the tail."
)

def assert_fits(n_rows, cols=3, dtype_bytes=8, factor=3.0, what="this DataFrame"):
    # Call BEFORE a large .df() (after a cheap COUNT(*)). Raises if the frame
    # cannot fit the cap. factor covers pandas overhead + downstream arrays.
    if not _MEM_LIMIT or not n_rows:
        return
    need = int(n_rows) * int(cols) * int(dtype_bytes) * float(factor)
    if need > _MEM_LIMIT * 0.80:
        _lim = "%.1f GB" % (_MEM_LIMIT / 1e9)
        raise MemoryError(
            "%s would need ~%.1f GB for %d rows, over the %s cap. "
            % (what, need / 1e9, int(n_rows), _lim) + _INFEASIBLE_MSG.format(limit=_lim)
        )

def _mem_watchdog():
    # Poll FAST (4x/sec): a .df() that materializes a multi-GB frame allocates in
    # a burst over a couple of seconds, and a coarse (1.5s) poll misses it — the
    # kernel OOM-kills between samples (observed: a 17-min run flat at ~1GB while
    # DuckDB spilled the scan, then the terminal .df() spiked past the cap in
    # seconds). At 0.25s we catch the climb through the threshold and abort with a
    # useful message before the kill.
    if not _MEM_LIMIT:
        return
    _hot = 0
    while True:
        _time.sleep(0.25)
        try:
            _frac = _mem_usage_bytes() / _MEM_LIMIT
        except Exception:
            continue
        if _frac >= 0.85:
            _hot += 1
            if _hot >= 2:  # ~0.5s sustained — not a one-sample blip
                _lim = "%.1f GB" % (_MEM_LIMIT / 1e9)
                # Tag the marker with the CURRENT progress phase so the host can
                # localize the OOM to a specific step (polygon build vs coarse
                # scan vs leaf read) and feed a phase-SPECIFIC fix into the retry
                # — a generic "you OOM'd" message is unactionable when the code is
                # already coordinates-only + counting (observed: retry reproduced
                # the same shape). Strip brackets/newlines so [phase=...] parses.
                _ph = str(_hb.get("phase") or "unknown").replace("]", ")").replace("\\n", " ")[:120]
                _sys.stderr.write(
                    "HERMETIC_OOM_PREDICTED: [phase=%s] memory reached %d%% of the %s cap — aborting "
                    "before the OOM-kill. " % (_ph, int(_frac * 100), _lim)
                    + _INFEASIBLE_MSG.format(limit=_lim) + "\\n")
                _sys.stderr.flush()
                _os._exit(137)
        else:
            _hot = 0
_threading.Thread(target=_mem_watchdog, daemon=True).start()

try:
    import pandas as _pd
    # Data-edge profiling hook (platform-owned completeness): the FIRST frame
    # loaded with a usable time column gets profiled; write_output ships the
    # result automatically. Best-effort — never blocks or raises.
    def _hermetic_profile_hook(_frame):
        try:
            import hermetic_runtime as _hrt_prof
            _hrt_prof.profile.maybe_profile(_frame)
        except Exception:
            pass
        return _frame
    _orig_read_csv = _pd.read_csv
    def _profiled_read_csv(*a, **kw):
        return _hermetic_profile_hook(_orig_read_csv(*a, **kw))
    _pd.read_csv = _profiled_read_csv
    try:
        _orig_read_parquet = _pd.read_parquet
        def _profiled_read_parquet(*a, **kw):
            return _hermetic_profile_hook(_orig_read_parquet(*a, **kw))
        _pd.read_parquet = _profiled_read_parquet
    except Exception:
        pass
    _orig_corr = _pd.DataFrame.corr
    _orig_cov = _pd.DataFrame.cov
    def _safe_corr(self, *a, **kw):
        return _orig_corr(self.select_dtypes(include="number"), *a, **kw)
    def _safe_cov(self, *a, **kw):
        return _orig_cov(self.select_dtypes(include="number"), *a, **kw)
    _pd.DataFrame.corr = _safe_corr
    _pd.DataFrame.cov = _safe_cov
except ImportError:
    pass
try:
    import duckdb as _duckdb_mod
    import re as _re_mod
    _orig_duckdb_sql = _duckdb_mod.sql
    _rc_pat = _re_mod.compile(r'read_csv\(([^)]+)\)')
    def _fix_read_csv(m):
        args = m.group(1)
        if 'delimiter' in args or 'delim' in args or 'sep' in args:
            return m.group(0)
        return 'read_csv(' + args + ", delimiter=',')"
    def _safe_duckdb_sql(query, *a, **kw):
        if 'read_csv(' in query:
            query = _rc_pat.sub(_fix_read_csv, query)
        return _orig_duckdb_sql(query, *a, **kw)
    _duckdb_mod.sql = _safe_duckdb_sql
    # Bound DuckDB to the CONTAINER cap so a huge scan / GROUP BY / ST_Contains
    # SPILLS to disk instead of ballooning past the cgroup limit and OS-OOM-killing
    # the whole process. DuckDB's default limit is 80% of DETECTED memory — inside a
    # container that's the VM's MemTotal, NOT the cgroup cap (measured: 2.3 GiB
    # default under a 3 GiB cap), which leaves almost nothing for the Python/httpfs
    # side and OOMs a big remote scan. Cap DuckDB LOW — leave ≥ ~1.5 GB (or half the
    # cap) for pandas/numpy/scipy + httpfs read buffers. Verified: a 179M-row USA
    # grid-count runs at ~72 MB peak under a 1 GB DuckDB limit, vs OOM at the default.
    # Apply each PRAGMA in its OWN try — a single unsupported SET on this DuckDB
    # build must NEVER skip the ones after it. (Bug: threads + preserve_insertion_order
    # + the config log used to share ONE try with SET max_temp_directory_size; if that
    # threw, the thread cap silently never applied and the 2.5B-row scan ran at
    # default all-cores → OOM. Observed exactly that.)
    def _ddb_set(_stmt):
        try:
            _orig_duckdb_sql(_stmt)
            return True
        except Exception:
            return False
    _ddb_mb = None
    if _MEM_LIMIT:
        _headroom = 1536 * 1024 * 1024  # bytes to reserve outside DuckDB
        _ddb_bytes = min(_MEM_LIMIT * 0.5, _MEM_LIMIT - _headroom)
        _ddb_mb = max(384, int(_ddb_bytes / (1024 * 1024)))
        _ddb_set("SET memory_limit='%dMB'" % _ddb_mb)
        _ddb_set("SET temp_directory='/tmp/duckdb_spill'")
        _ddb_set("SET max_temp_directory_size='40GB'")
    # Cap scan THREADS relative to the cap. memory_limit bounds DuckDB's buffer
    # manager (hash tables/sorts — spillable), NOT the parallel Parquet/httpfs scan's
    # per-thread row-group read+decompress buffers: those are LIVE (never spill) and
    # scale with thread count, so a default all-cores scan over a 2.5B-row remote
    # parquet blows the cgroup cap even with memory_limit set. ~1 thread per 1.5 GB of
    # cap keeps concurrent read buffers in budget; floor 2 for I/O overlap on a
    # network-bound S3 scan, never above the host cores.
    _cores = _os.cpu_count() or 4
    if _MEM_LIMIT:
        # ~1 thread per 2 GB of cap. At the observed ~4.6 GB container this yields
        # 2 — the ONLY value proven to complete a USA 2.5B-row scan (the one 15-min
        # success set threads=2 in its own code); 3 was never shown to work.
        _threads = max(2, min(_cores, int(_MEM_LIMIT / (1024 ** 3) / 2.0)))
    else:
        _threads = min(_cores, 4)
    _threads_ok = _ddb_set("SET threads=%d" % _threads)
    # Insertion-order preservation buffers a parallel scan's output so input order can
    # be restored at the end — pure retention overhead for aggregate/ORDER BY analytics
    # (our queries never rely on raw scan order). Off lets operators stream/spill.
    _ddb_set("SET preserve_insertion_order=false")
    # Self-report the RESOLVED config on TWO channels so it survives every death
    # mode. (1) A FILE (not stderr — a stderr write made it the first line other
    # error handlers grab, e.g. a parquet schema-extraction failure surfaced this
    # instead of the real DESCRIBE error): readable post-mortem WHEN the container
    # survives. (2) The LIVE stdout progress stream (a duckdb_cfg field): a hard
    # cgroup OOM-kill can reap the whole container's init, after which every
    # post-mortem 'docker exec cat /data/...' returns empty (OBSERVED: config,
    # stderr AND progress all came back blank on the 2.5B-row USA scan kills) — but
    # the host has already captured this line off the live stream before the kill.
    _cfg_str = ("threads=%d(applied=%s) memory_limit=%s preserve_insertion_order=false"
                % (_threads, _threads_ok, (("%dMB" % _ddb_mb) if _ddb_mb else "default")))
    try:
        with open("/data/hermetic_duckdb_cfg.txt", "w") as _cf:
            _cf.write("HERMETIC_DUCKDB_CFG: " + _cfg_str + "\\n")
    except Exception:
        pass
    try:
        progress(duckdb_cfg=_cfg_str)  # no phase change — keeps the current heartbeat phase
    except Exception:
        pass
    # ── Bounded .df() materialization guard (auto-injected) ──────────────────
    # .df() pulls the WHOLE result into pandas; a single unguarded pull of a
    # region's rows — especially with string/struct columns (Overture names, id,
    # class) — is THE recurring OOM (an 11-min run that then diverges on retry;
    # detailed guidance about COUNT-then-gate is routinely ignored on one read).
    # This REFUSES an oversized pull: it STREAMS the result in native pandas
    # chunks (single execution — never re-runs an expensive aggregate) and raises
    # the instant the row count crosses a TYPE-AWARE cap: generous for numeric-only
    # frames (KD-tree coords), tight for frames carrying string/struct columns
    # (which explode in pandas). Over the cap → a clear, retry-actionable error
    # instead of a silent OS-OOM. Reduce in DuckDB; .df() only the small result.
    # No-op when the memory cap is unknown; falls back on any non-memory error.
    try:
        if _MEM_LIMIT:
            # Only types that map to a COMPACT numpy dtype (int64/float64/bool) get
            # the generous row cap. DECIMAL, strings, structs, dates all materialize
            # as heavy Python OBJECTS in pandas — treat them as "wide" (low cap).
            _NUMERIC_DUCK = ("TINYINT", "SMALLINT", "INTEGER", "BIGINT", "UTINYINT",
                "USMALLINT", "UINTEGER", "UBIGINT", "FLOAT", "DOUBLE", "REAL", "BOOLEAN")
            _orig_rel_df = _duckdb_mod.DuckDBPyRelation.df
            def _df_row_cap(rel):
                try:
                    _types = [str(t).upper() for t in rel.types]
                except Exception:
                    return None
                _ncol = max(1, len(_types))
                _numeric = all(any(t.startswith(n) for n in _NUMERIC_DUCK) for t in _types)
                if _numeric:
                    return max(2000000, int(_MEM_LIMIT * 0.15) // (_ncol * 8))
                return 500000  # string/struct/list column → cap low (a legit wide result is the tiny top-N)
            def _capped_rel_df(self, *a, **kw):
                _cap = _df_row_cap(self)
                if _cap is None:
                    return _orig_rel_df(self, *a, **kw)
                # Materialize at most cap+1 rows in ONE efficient .df() (no concat
                # doubling, no re-run of an expensive aggregate). If it comes back
                # full, the real result is over the cap → refuse; otherwise the
                # limited result IS the complete result, so return it directly.
                try:
                    _probe = _orig_rel_df(self.limit(_cap + 1), *a, **kw)
                except Exception:
                    return _orig_rel_df(self, *a, **kw)  # odd relation → don't break a legit call
                if len(_probe) > _cap:
                    raise MemoryError(
                        ("This .df() would materialize %d+ rows into pandas — over the safe budget and "
                         "the top OOM cause. Do NOT pull scan/region rows into pandas: reduce in DuckDB "
                         "(COUNT / GROUP BY / aggregate / ORDER BY ... LIMIT k) and .df() ONLY the small "
                         "final result. For a spatial superlative, gate every point read by a COUNT you "
                         "already have (never read a cell/region that isn't provably small), and pull ONLY "
                         "numeric rowid,lon,lat into a KD-tree — never id/names/class/height.") % _cap)
                return _probe
            def _profiled_rel_df(self, *a, **kw):
                _f = _capped_rel_df(self, *a, **kw)
                try:
                    _hermetic_profile_hook(_f)
                except Exception:
                    pass
                return _f
            _duckdb_mod.DuckDBPyRelation.df = _profiled_rel_df
            _duckdb_mod.DuckDBPyRelation.fetchdf = _profiled_rel_df
    except Exception:
        pass
except ImportError:
    pass

# Hermetic runtime helpers (auto-injected): write_output(), safe_float(),
# safe_int(), assert_fits(), progress(). Prefer these over hand-rolling the output
# dict, numeric coercion, or qcut — they are the recurring crash sites.
import math as _math
def _to_native(o):
    try:
        import numpy as _np
    except Exception:
        _np = None
    import datetime as _dt
    from decimal import Decimal as _Dec
    if o is None:
        return None
    if isinstance(o, bool):
        return o
    if isinstance(o, float):
        return None if (_math.isnan(o) or _math.isinf(o)) else o
    if isinstance(o, (str, int)):
        return o
    if _np is not None and isinstance(o, _np.generic):
        return _to_native(o.item())
    if _np is not None and isinstance(o, _np.ndarray):
        return [_to_native(x) for x in o.tolist()]
    if isinstance(o, _Dec):
        f = float(o)
        return None if (_math.isnan(f) or _math.isinf(f)) else f
    if isinstance(o, (_dt.datetime, _dt.date)):
        return o.isoformat()
    try:
        import pandas as _pd
        if o is getattr(_pd, 'NaT', None):
            return None
        if isinstance(o, _pd.Timestamp):
            return o.isoformat()
        if isinstance(o, _pd.DataFrame):
            return [_to_native(r) for r in o.to_dict(orient='records')]
        if isinstance(o, _pd.Series):
            return _to_native(o.to_dict())
    except Exception:
        pass
    if isinstance(o, dict):
        return {str(k): _to_native(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [_to_native(x) for x in o]
    try:
        return str(o)
    except Exception:
        return None

def safe_float(x, default=None):
    # Never-raises float coercion for DISPLAY fields (a winner row's attributes:
    # height, num_floors, …). Returns default for None/NaN/Inf/blank/non-numeric
    # instead of throwing. Use this instead of hand-rolling
    # 'float(row[c]) if row[c] and not np.isnan(...)' — that pattern crashes on
    # None, strings, and numpy types, and has killed otherwise-successful runs.
    if x is None:
        return default
    try:
        import numpy as _np3
        if isinstance(x, _np3.generic):
            x = x.item()
        if x is None:
            return default
    except Exception:
        pass
    try:
        f = float(x)
    except (TypeError, ValueError):
        return default
    return default if (_math.isnan(f) or _math.isinf(f)) else f

def safe_int(x, default=None):
    # Never-raises int coercion (via safe_float), for counts/floors/year fields.
    f = safe_float(x, None)
    return default if f is None else int(f)

_HERMETIC_RUNTIME_FALLBACK = None

def write_output(results=None, chart_data=None, datasets=None, images=None, findings=None):
    # Write /data/output.json in the required structure. Coerces NaN/Inf/numpy/
    # Timestamp/Decimal to JSON-safe values and caps each dataset at 5000 rows.
    # Always writes the five top-level keys, so output is never silently empty.
    # findings needs NO argument — the declare_finding registry is the truth
    # (spec declared-findings-2026-08-06 §2.1); findings= is an explicit override.
    try:
        from hermetic_runtime.profile import get_profile as _hrt_get_profile
        _completeness = _hrt_get_profile()
    except Exception:
        _completeness = None
    out = {
        'runtime_fallback': _HERMETIC_RUNTIME_FALLBACK,
        'data_completeness': _to_native(_completeness),
        'results': _to_native(results if results is not None else {}),
        'chart_data': _to_native(chart_data if chart_data is not None else {}),
        'datasets': {},
        'images': _to_native(images if images is not None else {}),
        'findings': _to_native(findings if findings is not None else _hermetic_findings),
    }
    try:
        import pandas as _pd
    except Exception:
        _pd = None
    for _k, _v in (datasets or {}).items():
        _total = None
        if _pd is not None and isinstance(_v, _pd.DataFrame):
            _total = int(len(_v))
            _v = _v.head(5000).to_dict(orient='records')
        elif isinstance(_v, list):
            _total = len(_v)
            _v = _v[:5000]
        # When 'main' was truncated to the 5000-row cap, record the true total so
        # the dashboard can tell the user its interactive figures are a sample of N.
        if str(_k) == 'main' and _total is not None and _total > 5000:
            out['results']['_main_total'] = _total
        out['datasets'][str(_k)] = _to_native(_v)
    import json as _json2
    with open('/data/output.json', 'w') as _f:
        _json2.dump(out, _f, default=str, allow_nan=False)
    return out

def to_num(s):
    # Coerce a Series/sequence to numeric, stripping currency/commas/percent.
    import pandas as _pd
    ser = s if isinstance(s, _pd.Series) else _pd.Series(s)
    if ser.dtype.kind in 'biufc':
        return _pd.to_numeric(ser, errors='coerce')
    cleaned = (ser.astype(str)
               .str.replace(',', '', regex=False)
               .str.replace('$', '', regex=False)
               .str.replace('%', '', regex=False)
               .str.strip())
    return _pd.to_numeric(cleaned, errors='coerce')

def numeric(df, cols=None):
    # Numeric-only view of df (coerced) — safe for diff/corr/arithmetic.
    import pandas as _pd
    if cols is None:
        return df.apply(lambda c: _pd.to_numeric(c, errors='coerce')).select_dtypes(include='number')
    return _pd.DataFrame({c: to_num(df[c]) for c in cols})

def safe_qcut(s, q, labels=None):
    # qcut that won't crash on skewed / low-cardinality columns: drops duplicate
    # bin edges, falls back to fewer bins or a rank-based split.
    import pandas as _pd
    ser = to_num(s)
    nun = int(ser.dropna().nunique())
    if nun < 2:
        return _pd.Series(['all'] * len(ser), index=ser.index)
    k = q if isinstance(q, int) else len(q) - 1
    k = max(1, min(k, nun))
    lab = labels if (labels is None or len(labels) == k) else None
    try:
        return _pd.qcut(ser, k, labels=lab, duplicates='drop')
    except Exception:
        try:
            return _pd.qcut(ser.rank(method='first'), k, labels=lab, duplicates='drop')
        except Exception:
            return _pd.cut(ser, min(k, 2), duplicates='drop')

# ── Declared findings, fallback copy (spec declared-findings-2026-08-06 §2) ──
# Minimal declare_finding so the name NEVER NameErrors on a degraded deploy:
# registry append + sidecar JSONL + declaration-time coercion + code_ref. The
# tested package version (hermetic_runtime.findings) adds the §2.2 literal-rule
# AST check and overrides this below; the host scrubs regardless, so skipping
# that check here loses defense-in-depth, not the wall itself.
_hermetic_findings = []
def declare_finding(name, value, definition, dtype, unit=None,
                    derived_from_findings=None, derived_from_columns=None,
                    tags=None, method=None):
    # Declare a finding adjacent to its computation. Never raises; the value
    # is coerced NOW — the frame is live, and a raw np.nan surviving to
    # write_output would otherwise crash the run. Field names match
    # contracts/findings.ts FindingEntry exactly.
    try:
        try:
            _nm = name if isinstance(name, str) else str(name)
        except Exception:
            _nm = '<unprintable>'
        _entry = {
            'name': _nm,
            'definition': definition if isinstance(definition, str) else str(definition),
            'dtype': dtype if isinstance(dtype, str) else str(dtype),
            'value': _to_native(value),
        }
        if unit is not None:
            try: _entry['unit'] = unit if isinstance(unit, str) else str(unit)
            except Exception: pass
        for _fk, _fv in (('derived_from_findings', derived_from_findings),
                         ('derived_from_columns', derived_from_columns),
                         ('tags', tags)):
            if _fv:
                try: _entry[_fk] = [_x if isinstance(_x, str) else str(_x) for _x in list(_fv)]
                except Exception: pass
        if method is not None:
            try: _entry['method'] = method if isinstance(method, str) else str(method)
            except Exception: pass
        # code_ref: generated-code-relative (§2.4) — subtract the prelude's
        # self-measured line count (set at the END of this file), clamp at 1.
        try:
            _fr = _sys._getframe(1)
            _ln = int(_fr.f_lineno)
            _off = _fr.f_globals.get('_HERMETIC_PRELUDE_LINES')
            if isinstance(_off, int) and not isinstance(_off, bool) and _off > 0:
                _ln -= _off
            _entry['code_ref'] = 'script.py:%d' % max(1, _ln)
        except Exception:
            pass
        _hermetic_findings.append(_entry)
        try:
            with open('/data/findings.jsonl', 'a') as _sf:
                _sf.write(_json_mod.dumps(_entry, default=str) + chr(10))
        except Exception:
            pass
        return _entry
    except Exception:
        return None

# The stat helpers live ONLY in the package (they carry real math + tests);
# these stubs return each helper's documented never-raise failure shape so a
# degraded deploy degrades the STATS, never NameErrors the analysis. The
# model's own computation and declare_finding still work.
def finding_trend(values, unit=None):
    return {'direction': None, 'slope_per_period': None, 'p_value': None}
def finding_step_change(values, labels=None, counts=None):
    return {'period': None, 'delta': None, 'direction': None, 'baseline_spread': None}
def finding_decompose(total_change, terms):
    try:
        _out = {str(_k): _v for _k, _v in dict(terms).items()}
    except Exception:
        _out = {}
    _out['dominant'] = None
    _out['residual'] = None
    return _out
def finding_heterogeneity(groups):
    return {'significant': None, 'p_value': None, 'test': 'anova'}
def declare_check(name, definition, passed=None, evidence=None, severity='caveat', derived_from_columns=None):
    pass
def finding_superlative(labels, values, counts=None, kind='max'):
    return {'period': None, 'value': None, 'n': None, 'raw_period': None,
            'raw_value': None, 'raw_n': None, 'thin_periods_skipped': None}
def finding_split_comparison(labels, values, split_at=None):
    return {'early_median': None, 'late_median': None, 'early_n': None,
            'late_n': None, 'early_span': None, 'late_span': None,
            'multiplier': None}
def finding_yoy(period_labels, values):
    return {'prior_year': None, 'latest_year': None, 'window_months': None,
            'prior_total': None, 'latest_total': None, 'pct_change': None}
def finding_current_state(values, labels=None, window=6, coverage=None):
    return {'period': None, 'value': None, 'pct_from_peak': None,
            'direction': None, 'excluded_trailing': None}

# ── Hermetic runtime package override (auto-injected) ────────────────────────
# The helper definitions above are the LEGACY INLINE COPY. The host ships the
# TESTED package (docker/sandbox/hermetic_runtime/) into /data/hermetic_runtime
# with every run; when importable, its versions take over so there is one
# source of truth. The inline copy stays for one release as the fallback (a
# deployment that failed to ship the files degrades, not dies) and is removed
# next. The runtime_pkg progress field makes which path ran OBSERVABLE on the
# live stream and in the journal — never guess from behavior.
try:
    import sys as _rt_sys
    if "/data" not in _rt_sys.path:
        _rt_sys.path.insert(0, "/data")
    import hermetic_runtime as _hrt
    from hermetic_runtime import safe_float, safe_int, write_output, to_num, numeric, safe_qcut
    # One import statement for the findings surface: `import hermetic_runtime`
    # above already failed atomically if findings.py didn't ship, so a partial
    # override (package write_output reading a registry the fallback
    # declare_finding never fills — the spec's E6 silent-loss class) can't occur.
    from hermetic_runtime import (declare_finding, finding_trend, finding_step_change,
        finding_decompose, finding_heterogeneity, finding_current_state, finding_yoy,
        declare_check, finding_split_comparison, finding_superlative)
    from hermetic_runtime import to_native as _to_native
    _hrt.guards.configure(_MEM_LIMIT)
    assert_fits = _hrt.guards.assert_fits
    _INFEASIBLE_MSG = _hrt.guards.INFEASIBLE_MSG
    progress(runtime_pkg="hermetic_runtime")
except Exception as _rt_err:
    # The marker rides the OUTPUT ENVELOPE so the host can see (and surface)
    # that every stat helper was a stub — run 88e5d443 shipped 13 null
    # findings with perfect inputs and only a buried progress line said why.
    _HERMETIC_RUNTIME_FALLBACK = "%s: %s" % (type(_rt_err).__name__, _rt_err)
    try:
        progress(runtime_pkg="inline-fallback: %s" % _rt_err)
    except Exception:
        pass

# ── Egress proxy for DuckDB (auto-injected) ──────────────────────────────────
# Under a restricted-egress run (lib/sandbox/egress.ts) the container has no
# outbound route; the only door is the allowlist proxy named in
# HERMETIC_HTTP_PROXY. Python's urllib/requests honor the standard proxy env
# vars, but DuckDB 1.2.x reads its http_proxy SETTING only — so every duckdb
# connection is patched to apply it. Fail-closed by construction: if this
# patch missed a path, the read is blocked by the network, not silently open.
import os as _os
_hermetic_proxy = _os.environ.get("HERMETIC_HTTP_PROXY")
if _hermetic_proxy:
    try:
        import duckdb as _duckdb

        _orig_connect = _duckdb.connect

        def _proxied_connect(*a, **kw):
            con = _orig_connect(*a, **kw)
            try:
                con.execute("SET http_proxy=?", [_hermetic_proxy])
            except Exception:
                pass
            return con

        _duckdb.connect = _proxied_connect
        # The module-level default connection too (duckdb.sql(...) style).
        try:
            _duckdb.execute("SET http_proxy=?", [_hermetic_proxy])
        except Exception:
            pass
    except ImportError:
        pass

# ── Prelude line count (spec declared-findings-2026-08-06 §2.4) ──────────────
# The generated script is appended DIRECTLY after this file, so declare_finding
# must subtract the prelude's line count to make code_ref generated-code-
# relative ("script.py:41" cites the statement it claims to). Self-measured —
# the executing frame's line number ON the assignment below IS the prelude's
# last line, never a hardcoded constant. This MUST stay the final line of the
# file: anything added after it silently corrupts every code_ref.
_HERMETIC_PRELUDE_LINES = __import__('inspect').currentframe().f_lineno

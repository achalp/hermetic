import { executeSandbox as e2bExecutor } from "./executor";
import { executeSandbox as dockerExecutor } from "./docker-executor";
import { executeSandbox as microsandboxExecutor } from "./microsandbox-executor";
import { codeNeedsNetwork, codeDoesRemoteIo } from "./docker-utils";
import { getWarmManager } from "./warm-sandbox";
import type { ExecutionResult } from "@/lib/types";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";

export interface AdditionalFile {
  path: string;
  content: string;
}

/**
 * Python prelude injected before every generated script.
 * - Patches json.dump/dumps to force allow_nan=True (prevents NaN crash)
 * - Patches DataFrame.corr/cov to auto-select numeric columns (prevents
 *   "could not convert string to float" when LLM forgets select_dtypes)
 */
export const PYTHON_NAN_PRELUDE = `
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
    try:
        if _MEM_LIMIT:
            _headroom = 1536 * 1024 * 1024  # bytes to reserve outside DuckDB
            _ddb_bytes = min(_MEM_LIMIT * 0.5, _MEM_LIMIT - _headroom)
            _ddb_mb = max(384, int(_ddb_bytes / (1024 * 1024)))
            _orig_duckdb_sql("SET memory_limit='%dMB'" % _ddb_mb)
            _orig_duckdb_sql("SET temp_directory='/tmp/duckdb_spill'")
            _orig_duckdb_sql("SET max_temp_directory_size='40GB'")
        # Cap scan THREADS relative to the cap. memory_limit bounds DuckDB's buffer
        # manager (hash tables/sorts — spillable), NOT the parallel Parquet/httpfs
        # scan's per-thread row-group read+decompress buffers: those are LIVE (never
        # spill) and scale with thread count, so a default all-cores scan over a
        # 2.5B-row remote parquet blows the cgroup cap even with memory_limit set
        # (observed: 3x 20-25min OOMs on a USA superlative, fixed only by lowering
        # threads). ~1 thread per 1.5 GB of cap keeps concurrent read buffers within
        # budget; floor 2 for I/O overlap on a network-bound S3 scan, never above
        # the host cores.
        _cores = _os.cpu_count() or 4
        if _MEM_LIMIT:
            _threads = max(2, min(_cores, int(_MEM_LIMIT / (1024 ** 3) / 1.5)))
        else:
            _threads = min(_cores, 4)
        _orig_duckdb_sql("SET threads=%d" % _threads)
        # Insertion-order preservation buffers a parallel scan's output so input
        # order can be restored at the end — pure retention overhead for aggregate/
        # ORDER BY analytics (our queries never rely on raw scan order). Off lets
        # operators stream/spill instead of holding rows to reorder them.
        _orig_duckdb_sql("SET preserve_insertion_order=false")
        # Self-report the RESOLVED DuckDB config so the host logs prove which
        # settings actually applied in THIS container — no more guessing whether a
        # prelude change is live. Marker line is greppable in stdout/stderr.
        _sys.stderr.write(
            "HERMETIC_DUCKDB_CFG: threads=%d memory_limit=%s preserve_insertion_order=false\\n"
            % (_threads, (("%dMB" % _ddb_mb) if _MEM_LIMIT else "default"))
        )
        _sys.stderr.flush()
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
            _duckdb_mod.DuckDBPyRelation.df = _capped_rel_df
            _duckdb_mod.DuckDBPyRelation.fetchdf = _capped_rel_df
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

def write_output(results=None, chart_data=None, datasets=None, images=None):
    # Write /data/output.json in the required structure. Coerces NaN/Inf/numpy/
    # Timestamp/Decimal to JSON-safe values and caps each dataset at 5000 rows.
    # Always writes the four top-level keys, so output is never silently empty.
    out = {
        'results': _to_native(results if results is not None else {}),
        'chart_data': _to_native(chart_data if chart_data is not None else {}),
        'datasets': {},
        'images': _to_native(images if images is not None else {}),
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
`;

type SandboxExecutor = (
  csv: string,
  code: string,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[]
) => Promise<ExecutionResult>;

const executors: Record<SandboxRuntimeId, SandboxExecutor> = {
  docker: dockerExecutor,
  e2b: e2bExecutor,
  microsandbox: microsandboxExecutor,
};

export function executeSandbox(
  csvContent: string,
  code: string,
  runtime?: SandboxRuntimeId,
  geojsonContent?: string | null,
  additionalFiles?: AdditionalFile[],
  csvId?: string,
  localMountPath?: string,
  inputParquetPath?: string
): Promise<ExecutionResult> {
  const rt = runtime ?? getActiveSandboxRuntime();

  // Both a bind-mount (browsed local files) and a copied-in Parquet (materialized
  // data) need the ephemeral Docker path — the warm container can't take a volume,
  // and a per-run copied file shouldn't leak across the shared warm container.
  if (localMountPath || inputParquetPath) {
    if (rt !== "docker") {
      return Promise.resolve({
        success: false,
        error: "Parquet/local-file analysis is only supported with the Docker sandbox runtime.",
        execution_ms: 0,
      });
    }
    return dockerExecutor(
      csvContent,
      code,
      geojsonContent,
      additionalFiles,
      localMountPath,
      inputParquetPath
    );
  }

  // Remote cloud reads (s3://, httpfs) need the extended large-data timeout,
  // which only the Docker path budgets — on microsandbox/E2B the same code
  // just died at the 30s default and burned the retry budget with a spurious
  // "timed out" that never named the real cause. Reject with the cause.
  if (rt !== "docker" && codeDoesRemoteIo(code)) {
    return Promise.resolve({
      success: false,
      error:
        "Remote cloud data reads (s3://, https:// Parquet over httpfs) are only supported with " +
        "the Docker sandbox runtime — other runtimes cap execution at the default timeout, which " +
        "remote scans exceed. Switch to Docker in Settings → Sandbox Runtime.",
      execution_ms: 0,
    });
  }

  // The warm Docker container runs with --network none (shared, created
  // before any code is known). Code that reads remote data gets a fresh
  // ephemeral container with network instead of the warm path.
  if (rt === "docker" && codeNeedsNetwork(code)) {
    return dockerExecutor(csvContent, code, geojsonContent, additionalFiles);
  }

  // Route through warm manager when available (not for E2B)
  if (rt !== "e2b" && csvId) {
    const manager = getWarmManager(rt);
    if (manager) {
      return manager.execute(csvId, csvContent, code, geojsonContent, additionalFiles);
    }
  }

  // Fallback to ephemeral executors
  return (executors[rt] ?? dockerExecutor)(csvContent, code, geojsonContent, additionalFiles);
}

export { prepareWarmSandbox, warmupAllSandboxes } from "./warm-sandbox";

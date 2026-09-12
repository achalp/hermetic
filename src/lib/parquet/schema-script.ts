import { LOCAL_MOUNT_PATH, DEFAULT_PROFILE_DEPTH } from "@/lib/constants";

/**
 * Rows materialized in the WORKER for per-column stats. An order of magnitude
 * below the container's 500k: this table lives in the WASM heap and every row of
 * it crosses the ranged endpoint.
 */
export const WASM_SCHEMA_SAMPLE_ROWS = 50_000;

/**
 * Parquet footers read to estimate the row count. Each one is a synchronous XHR,
 * so an unbounded read over a 1500-file source would dominate the connect.
 */
export const WASM_SCHEMA_FOOTER_FILES = 16;
import {
  DUCKDB_CLOUD_PRELUDE,
  parquetReadExpr,
  normalizeRemoteParquetUrl,
} from "@/lib/parquet/duckdb-source";

// Under the egress-allowlist proxy, AWS/GCS are reachable ONLY via their
// virtual-hosted host (deriveAllowedEgressHosts allows `bucket.s3.amazonaws.com`,
// never the generic `s3.amazonaws.com`). DuckDB defaults to path-style, which
// would 403 at the proxy, so — exactly as the analysis prelude does — pin
// s3_url_style from HERMETIC_S3_URL_STYLE (set to "vhost" by setupEgressNetwork
// for AWS). Parameterized SET, and a no-op when the env var is unset (local /
// custom-endpoint reads). Mirrors docker/sandbox/prelude.py.
const S3_URL_STYLE_FROM_ENV_PY = `import os as _os
_s3_style = _os.environ.get("HERMETIC_S3_URL_STYLE")
if _s3_style:
    con.execute("SET s3_url_style=?", [_s3_style])
`;

/**
 * The source-agnostic tail of the extraction script: given `describe`,
 * `row_count`, a `stats_data` temp table (aliased `STATS_TABLE`), and the
 * MAX_* constants, it computes per-column stats + correlations and writes a
 * CSVSchema-compatible JSON to /data/output.json. Shared verbatim by the local
 * and remote (cloud Parquet) setups so the profiling logic lives in ONE place.
 */
/** DuckDB type → schema dtype. Shared by BOTH tails so a describe-only tier and
 *  a full profile of the same source always report the SAME dtype for a column —
 *  an upgrade must add statistics, never silently change a type. */
const DTYPE_MAPPER_PY = `
# Map DuckDB types to schema dtypes
def map_dtype(duckdb_type):
    t = duckdb_type.upper()
    # Complex / nested types (STRUCT, LIST/ARRAY, MAP, UNION) and geometry can't
    # be profiled with scalar aggregates like AVG/MIN — and substring matching
    # would otherwise misread e.g. STRUCT(... confidence DOUBLE ...)[] as a number.
    # Treat them as strings; they're sampled via CAST(... AS VARCHAR).
    if any(k in t for k in ['STRUCT', 'MAP', 'UNION', 'LIST', 'ARRAY', '[]', 'GEOMETRY']):
        return 'complex'
    if any(k in t for k in ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NUMERIC', 'REAL', 'HUGEINT']):
        return 'number'
    if any(k in t for k in ['DATE', 'TIMESTAMP', 'TIME']):
        return 'date'
    if 'BOOL' in t:
        return 'boolean'
    return 'string'

`;

const SHARED_STATS_TAIL =
  DTYPE_MAPPER_PY +
  `
# Per-column (min, max) read from Parquet FOOTERS by the setup, when the source
# has footers and the writer recorded statistics. Empty dict = unavailable.
FOOTER_RANGES = globals().get('FOOTER_RANGES', {})

columns_info = []
for col_name, col_type, *_ in describe:
    columns_info.append({
        'name': col_name,
        'duckdb_type': col_type,
        'dtype': map_dtype(col_type),
    })

def safe_float(v):
    """Convert to float, replacing inf/nan with None."""
    if v is None:
        return None
    f = float(v)
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, 6)

def safe_int(v):
    if v is None:
        return 0
    return int(v)

# ── Per-column metadata ──────────────────────────────────────────
columns = []
numeric_cols = []

# Columns deliberately NOT materialized into the stats table (a setup may skip
# a fat GEOMETRY/BLOB column whose bytes would dominate a remote read). They keep
# their real NAME and TYPE; their value-derived stats are reported as UNKNOWN
# rather than fabricated — a 100%-null geometry column would be a lie the model
# would act on.
SKIPPED_COLS = globals().get('SKIPPED_COLS', set())

# ── Batched pre-passes (perf, NOT fidelity) ──────────────────────
# Every scalar aggregate below used to run as its OWN query per column, so a
# 23-column table issued ~50 sequential full scans of the (up to 500k-row)
# sample, and correlations issued one query per C(n,2) PAIR — the top-10 cap
# applied only to the OUTPUT, not the work. Collapsing them into batched
# single-pass queries is value-for-value IDENTICAL: these are the same
# aggregate functions over the same rows, and DuckDB evaluates each aggregate
# expression independently (verified empirically against DuckDB on 200k rows of
# adversarial data — per-column nulls at different offsets, an all-null column,
# ties, negatives, skew — all values byte-identical, correlations included).
# Percentiles deliberately stay as separate exact MEDIAN / PERCENTILE_CONT
# calls. Two tempting speedups were REJECTED after measurement: the list form
# of PERCENTILE_CONT returns DECIMAL elements as STRINGS (a representation
# change the model would see), and the approximate-quantile function trades
# exactness for speed. The sample size and every value stay as they were.
AGG_BATCH = 6  # columns per query: bounds concurrent percentile sorts

def _agg_specs(ci):
    """(suffix, sql) aggregate list for one column — mirrors the per-dtype
    queries below exactly."""
    e = ci['name'].replace('"', '""')
    q = f'"{e}"'
    specs = [('nulls', f"COUNT(*) FILTER ({q} IS NULL)")]
    d = ci['dtype']
    if d == 'number':
        specs += [
            ('mn', f"MIN({q})"), ('mx', f"MAX({q})"), ('av', f"AVG({q})"),
            ('md', f"MEDIAN({q})"), ('sd', f"STDDEV({q})"),
            ('p25', f"PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY {q})"),
            ('p75', f"PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY {q})"),
            ('zero', f"COUNT(*) FILTER ({q} = 0)"),
            ('neg', f"COUNT(*) FILTER ({q} < 0)"),
            ('skew', f"SKEWNESS({q})"), ('kurt', f"KURTOSIS({q})"),
            ('nullpct', f"COUNT(*) FILTER ({q} IS NULL) * 100.0 / NULLIF(COUNT(*), 0)"),
        ]
    elif d == 'date':
        specs += [('mn', f"MIN({q})"), ('mx', f"MAX({q})")]
    elif d == 'boolean':
        specs += [('t', f"COUNT(*) FILTER ({q} = TRUE)"), ('f', f"COUNT(*) FILTER ({q} = FALSE)")]
    else:
        specs += [
            ('nd', f"COUNT(DISTINCT {q})"),
            ('lavg', f"AVG(LENGTH(CAST({q} AS VARCHAR))) FILTER ({q} IS NOT NULL)"),
            ('lmax', f"MAX(LENGTH(CAST({q} AS VARCHAR))) FILTER ({q} IS NOT NULL)"),
            ('lmin', f"MIN(LENGTH(CAST({q} AS VARCHAR))) FILTER ({q} IS NOT NULL)"),
        ]
    return specs

_profiled = [ci for ci in columns_info if ci['name'] not in SKIPPED_COLS]
AGG = {}
for _b in range(0, len(_profiled), AGG_BATCH):
    _chunk = _profiled[_b:_b + AGG_BATCH]
    _sel = []
    for _i, ci in enumerate(_chunk):
        for _suffix, _sql in _agg_specs(ci):
            _sel.append(f'{_sql} AS "c{_b + _i}__{_suffix}"')
    if not _sel:
        continue
    _row = con.sql(f"SELECT {', '.join(_sel)} FROM {STATS_TABLE}").fetchone()
    _names = [f"c{_b + _i}__{_s}" for _i, ci in enumerate(_chunk) for _s, _ in _agg_specs(ci)]
    for _n, _v in zip(_names, _row):
        AGG[_n] = _v
_AGG_IDX = {ci['name']: i for i, ci in enumerate(_profiled)}

def _a(col_name, suffix):
    return AGG.get(f"c{_AGG_IDX[col_name]}__{suffix}")

# Outliers need p25/p75 from the pass above, so they are a SECOND batched pass
# (same IQR bounds, same COUNT — just not one query per column).
OUTLIERS = {}
_num = [ci for ci in _profiled if ci['dtype'] == 'number']
for _b in range(0, len(_num), AGG_BATCH):
    _chunk = _num[_b:_b + AGG_BATCH]
    _sel, _keys = [], []
    for ci in _chunk:
        _p25 = safe_float(_a(ci['name'], 'p25')) or 0
        _p75 = safe_float(_a(ci['name'], 'p75')) or 0
        _iqr = _p75 - _p25
        if _iqr <= 0:
            OUTLIERS[ci['name']] = 0
            continue
        _e = ci['name'].replace('"', '""')
        _q = f'"{_e}"'
        _lo = _p25 - 1.5 * _iqr
        _hi = _p75 + 1.5 * _iqr
        _keys.append(ci['name'])
        _sel.append(f'COUNT(*) FILTER ({_q} < {_lo} OR {_q} > {_hi}) AS "o{len(_keys) - 1}"')
    if _sel:
        _row = con.sql(f"SELECT {', '.join(_sel)} FROM {STATS_TABLE}").fetchone()
        for _k, _v in zip(_keys, _row):
            OUTLIERS[_k] = _v

for ci in columns_info:
    col_name = ci['name']
    dtype = ci['dtype']
    escaped = col_name.replace('"', '""')
    q = f'"{escaped}"'

    if col_name in SKIPPED_COLS:
        # Structurally valid and explicitly UNMEASURED (ColumnMeta's
        # 'unprofiled' variant). A null meta crashed every consumer that
        # switches on meta.kind; a zeroed categorical meta would have claimed
        # a distinct count nobody counted.
        columns.append({
            'name': col_name,
            'dtype': dtype,
            'null_count': 0,
            'sample_values': [],
            'meta': {
                'kind': 'unprofiled',
                'reason': 'geometry/blob column not read (its bytes are the scan cost)',
            },
        })
        continue

    # Null count — from the batched pre-pass (same aggregate, one scan).
    null_count = _a(col_name, 'nulls')

    # Sample values
    sample_vals = con.sql(
        f"SELECT CAST({q} AS VARCHAR) FROM {STATS_TABLE} WHERE {q} IS NOT NULL LIMIT {MAX_SAMPLE_ROWS}"
    ).fetchall()
    sample_values = [str(r[0]) for r in sample_vals]

    meta = None

    if dtype == 'number':
        numeric_cols.append(col_name)
        row = [
            _a(col_name, 'mn'), _a(col_name, 'mx'), _a(col_name, 'av'),
            _a(col_name, 'md'), _a(col_name, 'sd'), _a(col_name, 'p25'),
            _a(col_name, 'p75'), _a(col_name, 'zero'), _a(col_name, 'neg'),
            _a(col_name, 'skew'), _a(col_name, 'kurt'), _a(col_name, 'nullpct'),
        ]

        p25 = safe_float(row[5]) or 0
        p75 = safe_float(row[6]) or 0
        iqr = p75 - p25

        # Outlier count via IQR method — from the batched second pass.
        outlier_count = OUTLIERS.get(col_name, 0)

        # Detect integer vs float
        is_integer = 'INT' in ci['duckdb_type'].upper()
        decimal_precision = 0 if is_integer else 2

        # RANGE FROM THE FOOTERS when available. min/max are the statistics a
        # prefix gets most wrong: a spatially sorted dataset's leading rows give
        # the range of ONE region, and a planner sizes grids and axes from it.
        # Parquet row-group statistics carry the true per-column min/max for the
        # WHOLE dataset and cost no data scan, so they beat any sample — at any
        # depth. Absent (writer wrote none, or a non-primitive column) → fall back
        # to the sample's range, which is what we had before.
        _fmin, _fmax = FOOTER_RANGES.get(col_name, (None, None))
        meta = {
            'kind': 'number',
            'is_integer': is_integer,
            'decimal_precision': decimal_precision,
            'is_currency': False,
            'is_percentage': False,
            'min': (_fmin if _fmin is not None else safe_float(row[0])) or 0,
            'max': (_fmax if _fmax is not None else safe_float(row[1])) or 0,
            'mean': safe_float(row[2]) or 0,
            'median': safe_float(row[3]) or 0,
            'std_dev': safe_float(row[4]) or 0,
            'p25': p25,
            'p75': p75,
            'zero_count': safe_int(row[7]),
            'negative_count': safe_int(row[8]),
            'skewness': safe_float(row[9]),
            'kurtosis': safe_float(row[10]),
            'outlier_count': safe_int(outlier_count),
            'null_pct': safe_float(row[11]),
        }

    elif dtype == 'date':
        row = [_a(col_name, 'mn'), _a(col_name, 'mx')]

        min_date = str(row[0]) if row[0] else ''
        max_date = str(row[1]) if row[1] else ''

        has_time = 'TIMESTAMP' in ci['duckdb_type'].upper() or 'TIME' in ci['duckdb_type'].upper()

        # Rough granularity detection
        granularity = 'day'
        if has_time:
            granularity = 'second'

        meta = {
            'kind': 'date',
            'format': 'ISO8601',
            'min_date': min_date,
            'max_date': max_date,
            'uses_month_names': False,
            'uses_day_names': False,
            'has_time': has_time,
            'granularity': granularity,
        }

    elif dtype == 'boolean':
        row = [_a(col_name, 't'), _a(col_name, 'f')]

        meta = {
            'kind': 'boolean',
            'true_count': safe_int(row[0]),
            'false_count': safe_int(row[1]),
            'representation': 'true/false',
        }

    elif dtype == 'complex':
        # Nested (STRUCT/LIST/MAP) or geometry columns can't be aggregated or
        # grouped like scalars. Report them as string-shaped with only the cheap
        # VARCHAR-cast sample values already gathered above; skip distinct/length
        # stats that would fail or be meaningless. dtype is surfaced as 'string'
        # so downstream consumers stay within the known dtype set.
        dtype = 'string'
        sample_len = max((len(v) for v in sample_values), default=0)
        meta = {
            'kind': 'categorical',
            'distinct_count': 0,
            'distinct_values': None,
            'top_values': [],
            'avg_length': float(sample_len),
            'max_length': sample_len,
            'min_length': 0,
            'is_unique': False,
        }

    else:  # string / categorical
        distinct_count = _a(col_name, 'nd')

        # Top values
        top_vals = con.sql(f"""
            SELECT CAST({q} AS VARCHAR) as val, COUNT(*) as cnt
            FROM {STATS_TABLE}
            WHERE {q} IS NOT NULL
            GROUP BY {q}
            ORDER BY cnt DESC
            LIMIT {MAX_TOP_VALUES}
        """).fetchall()
        top_values = [{'value': str(r[0]), 'count': int(r[1])} for r in top_vals]

        # Distinct values (if cardinality is low)
        distinct_values = None
        if distinct_count <= MAX_DISTINCT_VALUES:
            dv = con.sql(f"""
                SELECT DISTINCT CAST({q} AS VARCHAR)
                FROM {STATS_TABLE}
                WHERE {q} IS NOT NULL
                ORDER BY 1
            """).fetchall()
            distinct_values = [str(r[0]) for r in dv]

        # String length stats — batched pre-pass (FILTER mirrors the old WHERE).
        len_row = [_a(col_name, 'lavg'), _a(col_name, 'lmax'), _a(col_name, 'lmin')]

        is_unique = distinct_count == row_count

        meta = {
            'kind': 'categorical',
            'distinct_count': safe_int(distinct_count),
            'distinct_values': distinct_values,
            'top_values': top_values,
            'avg_length': safe_float(len_row[0]) or 0,
            'max_length': safe_int(len_row[1]),
            'min_length': safe_int(len_row[2]),
            'is_unique': is_unique,
        }

    columns.append({
        'name': col_name,
        'dtype': dtype,
        'null_count': safe_int(null_count),
        'meta': meta,
        'sample_values': sample_values,
    })

# ── Sample rows ──────────────────────────────────────────────────
sample_df = con.sql(f"SELECT * FROM {STATS_TABLE} LIMIT {MAX_SAMPLE_ROWS}").fetchdf()
sample_rows = []
for _, row in sample_df.iterrows():
    sample_rows.append({str(k): str(v) if v is not None else '' for k, v in row.items()})

# ── Correlations ─────────────────────────────────────────────────
correlations = []
if len(numeric_cols) >= 2:
    pairs = []
    for i in range(len(numeric_cols)):
        for j in range(i + 1, len(numeric_cols)):
            pairs.append((numeric_cols[i], numeric_cols[j]))

    # ONE query for every pair (was one query PER pair, and the top-N cap below
    # applied only to the OUTPUT — so C(n,2) full scans ran regardless). CORR
    # still performs its own pairwise NULL deletion per expression; verified
    # value-for-value identical against DuckDB.
    if pairs:
        _sel = []
        for _i, (col_a, col_b) in enumerate(pairs):
            _ea = col_a.replace('"', '""')
            _eb = col_b.replace('"', '""')
            _sel.append(f'CORR("{_ea}", "{_eb}") AS "r{_i}"')
        try:
            _row = con.sql(f"SELECT {', '.join(_sel)} FROM {STATS_TABLE}").fetchone()
        except Exception:
            _row = [None] * len(pairs)
        for (col_a, col_b), r in zip(pairs, _row):
            # Identical filter + key names + rounding as the per-pair version:
            # keys col_a/col_b, pearson rounded to 4dp (NOT safe_float's 6dp).
            if r is not None and not math.isnan(r):
                correlations.append({
                    'col_a': col_a,
                    'col_b': col_b,
                    'pearson': round(float(r), 4),
                })

    # Sort by absolute correlation, keep top N
    correlations.sort(key=lambda c: abs(c['pearson']), reverse=True)
    correlations = correlations[:MAX_CORRELATION_PAIRS]

# ── Domain detection ─────────────────────────────────────────────
col_names_lower = [c['name'].lower() for c in columns]
dtypes = [c['dtype'] for c in columns]

detected_domain = 'general'
ohlc = {'open', 'high', 'low', 'close'}
if ohlc.issubset(set(col_names_lower)):
    detected_domain = 'financial'
elif any(d == 'date' for d in dtypes) and sum(1 for d in dtypes if d == 'number') >= 2:
    detected_domain = 'time_series'
elif sum(1 for d in dtypes if d == 'number') >= 4:
    detected_domain = 'statistical'

# ── Output ───────────────────────────────────────────────────────
# PROVENANCE — say how these statistics were obtained. PROFILE_BASIS_KIND is set
# by the source setup: a remote read profiles the leading row groups (a PREFIX,
# not a random sample — a random sample over S3 would egress everything), while a
# local source can afford a true random sample. A prefix of a spatially sorted
# dataset describes one region, so a consumer must be able to tell the two apart
# instead of reading every number as dataset-wide.
_basis_kind = globals().get('PROFILE_BASIS_KIND', 'leading_prefix')
_examined = con.sql(f"SELECT COUNT(*) FROM {STATS_TABLE}").fetchone()[0] or 0
if _basis_kind != 'full_scan' and row_count and int(_examined) >= int(row_count):
    _basis_kind = 'full_scan'

output = {
    'row_count': row_count,
    'columns': columns,
    'sample_rows': sample_rows,
    'correlations': correlations if correlations else None,
    'detected_domain': detected_domain,
    'profile_basis': {'kind': _basis_kind, 'rows_examined': int(_examined)},
}

# The setup may point this at a PER-ENTITY path so concurrent extractions in
# one container cannot overwrite each other's results (batch parallelism).
OUTPUT_PATH = globals().get('OUTPUT_PATH', '/data/output.json')
json.dump(output, open(OUTPUT_PATH, 'w'), default=str, allow_nan=False)
`;

/** Source setup for a LOCAL Parquet file or folder (bind-mounted at /data/local).
 *  Produces con / describe / row_count / stats_data + the MAX_* constants. */
function localSetup(
  filename: string,
  isFolder: boolean,
  isHivePartitioned: boolean | undefined,
  depth: number
): string {
  const dataPath = isFolder
    ? `${LOCAL_MOUNT_PATH}/**/*.parquet`
    : `${LOCAL_MOUNT_PATH}/${filename}`;
  return `
import duckdb
import json
import math
import glob
import os

con = duckdb.connect()

DATA_PATH = '${dataPath}'
IS_FOLDER = ${isFolder ? "True" : "False"}
IS_HIVE = ${isFolder && isHivePartitioned ? "True" : "False"}
MAX_SAMPLE_ROWS = 5
MAX_DISTINCT_VALUES = 20
MAX_TOP_VALUES = 10
MAX_CORRELATION_PAIRS = 10
STATS_SAMPLE_SIZE = ${depth}
# A LOCAL source can afford a genuine random sample (USING SAMPLE below): the
# bytes are already on this machine, so spreading the read costs nothing. The
# remote path cannot — see ProfileBasis.
PROFILE_BASIS_KIND = 'random_sample'

# ── Smart file discovery for Hive datasets ───────────────────────
# For Hive-partitioned datasets, avoid globbing all files for every query.
# Instead: get schema from one file, estimate row count from metadata,
# and sample from a small subset of partition files.

mount_path = '${LOCAL_MOUNT_PATH}'

if IS_FOLDER:
    all_files = sorted(glob.glob(os.path.join(mount_path, '**', '*.parquet'), recursive=True))
    total_files = len(all_files)

    if total_files == 0:
        raise RuntimeError(f"No .parquet files found under {mount_path}")

    # Schema from the first file (all partitions share the same schema)
    first_file = all_files[0]
    hive_opt = ", hive_partitioning=true" if IS_HIVE else ""
    READ_SINGLE = f"read_parquet('{first_file}'{hive_opt})"

    # For stats, pick a representative subset of files (up to 20 spread across partitions)
    if total_files <= 20:
        sample_files = all_files
    else:
        step = total_files // 20
        sample_files = [all_files[i * step] for i in range(20)]

    sample_list = ", ".join(f"'{f}'" for f in sample_files)
    READ_SAMPLE = f"read_parquet([{sample_list}]{hive_opt})"

    # Full dataset reference (only used for row count via metadata)
    READ_FULL = f"read_parquet('{mount_path}/**/*.parquet'{hive_opt})"

    # Row count: sum row counts from parquet metadata (reads footers only, no data)
    try:
        row_count = con.sql(f"SELECT SUM(num_rows) FROM parquet_file_metadata('{mount_path}/**/*.parquet')").fetchone()[0]
    except Exception:
        # Fallback: count from sample and extrapolate
        sample_count = con.sql(f"SELECT COUNT(*) FROM {READ_SAMPLE}").fetchone()[0]
        row_count = int(sample_count * total_files / len(sample_files))

    # Schema from full glob (includes Hive partition columns)
    describe = con.sql(f"DESCRIBE SELECT * FROM {READ_FULL} LIMIT 0").fetchall()

    # Materialize sample into a temp table for fast repeated stats queries
    con.sql(f"CREATE TEMP TABLE stats_data AS SELECT * FROM {READ_SAMPLE} USING SAMPLE {STATS_SAMPLE_SIZE} ROWS")

else:
    READ_FULL = f"read_parquet('{DATA_PATH}')"
    describe = con.sql(f"DESCRIBE SELECT * FROM {READ_FULL}").fetchall()
    row_count = con.sql(f"SELECT COUNT(*) FROM {READ_FULL}").fetchone()[0]

    if row_count > STATS_SAMPLE_SIZE:
        con.sql(f"CREATE TEMP TABLE stats_data AS SELECT * FROM {READ_FULL} USING SAMPLE {STATS_SAMPLE_SIZE}")
    else:
        con.sql(f"CREATE TEMP TABLE stats_data AS SELECT * FROM {READ_FULL}")

STATS_TABLE = 'stats_data'
`;
}

/**
 * Build a Python script that uses DuckDB to extract full CSVSchema-compatible
 * metadata from a Parquet file or folder of Parquet files.
 *
 * The script writes a JSON object to /data/output.json matching the CSVSchema
 * interface (minus csv_id and filename, which are set by the caller).
 */
export function buildSchemaScript(
  filename: string,
  isFolder: boolean,
  isHivePartitioned?: boolean,
  depth: number = DEFAULT_PROFILE_DEPTH
): string {
  return localSetup(filename, isFolder, isHivePartitioned, depth) + SHARED_STATS_TAIL;
}

/** Source setup for a REMOTE cloud Parquet URL (s3:// or https://), read directly
 *  via DuckDB httpfs. Loads the cloud/geo extensions, takes the row count from
 *  Parquet FOOTERS (metadata only, no data scan — critical over the network), and
 *  profiles a bounded prefix of the data. `readUrl` MUST be a pre-validated URL
 *  (see isSafeParquetUrl) — it is interpolated into the DuckDB SQL. */
function remoteDescribeSetup(
  readUrl: string,
  authSql: string,
  isHivePartitioned = false,
  depth: number = DEFAULT_PROFILE_DEPTH
): string {
  const url = normalizeRemoteParquetUrl(readUrl);
  const auth = authSql ? `con.sql("${authSql}")\n` : "";
  const readExpr = parquetReadExpr(url, isHivePartitioned);
  return `
import duckdb
import json
import math

MAX_SAMPLE_ROWS = 5
MAX_DISTINCT_VALUES = 20
MAX_TOP_VALUES = 10
MAX_CORRELATION_PAIRS = 10
STATS_SAMPLE_SIZE = ${depth}
FOOTER_SAMPLE_FILES = 32
PROFILE_BASIS_KIND = 'leading_prefix'

con = duckdb.connect()
con.sql("${DUCKDB_CLOUD_PRELUDE}")
${S3_URL_STYLE_FROM_ENV_PY}${auth}
PATTERN = '${url}'
READ_FULL = "${readExpr}"
# Files to spread the sample across (see the stats-table fragment). 32 matches the
# footer sample: enough to span a dataset, few enough that the per-file request
# overhead stays small against the bytes actually read.
SPREAD_FILES = 32
_hive_arg = ${JSON.stringify(isHivePartitioned ? ", hive_partitioning=true" : "")}

# Schema from the dataset (opens one file; partition columns included via hive).
describe = con.sql(f"DESCRIBE SELECT * FROM {READ_FULL}").fetchall()

# Row count from Parquet footers (metadata only, no data scan). Over the network,
# reading EVERY footer is too slow for a large dataset (hundreds/thousands of
# shards — Overture buildings is 500+ files), so BOUND it: list the files, read a
# spread-out sample of footers, and extrapolate by file count. A small dataset
# (<= the sample size) is counted exactly.
try:
    files = [r[0] for r in con.sql(f"SELECT file FROM glob('{PATTERN}')").fetchall()]
except Exception:
    files = []
total_files = len(files)
try:
    if total_files == 0:
        # DuckDB still resolves a single-file URL (or its own glob) via metadata.
        row_count = con.sql(f"SELECT SUM(num_rows) FROM parquet_file_metadata('{PATTERN}')").fetchone()[0] or 0
    else:
        if total_files <= FOOTER_SAMPLE_FILES:
            sample = files
        else:
            step = total_files // FOOTER_SAMPLE_FILES
            sample = [files[i * step] for i in range(FOOTER_SAMPLE_FILES)]
        quoted = ", ".join("'" + f.replace("'", "''") + "'" for f in sample)
        sampled = con.sql(f"SELECT SUM(num_rows) FROM parquet_file_metadata([{quoted}])").fetchone()[0] or 0
        row_count = int(sampled * total_files / len(sample))
    row_count = int(row_count)
    # Exact only when every footer was read; a spread-sample extrapolation is not.
    row_count_exact = (total_files <= FOOTER_SAMPLE_FILES)
except Exception:
    row_count = 0
    row_count_exact = False
`;
}

/** Remote setup for a FULL profile: the describe half plus the prefix sample. */
function remoteSetup(
  readUrl: string,
  authSql: string,
  isHivePartitioned = false,
  depth: number = DEFAULT_PROFILE_DEPTH
): string {
  return remoteDescribeSetup(readUrl, authSql, isHivePartitioned, depth) + REMOTE_STATS_TABLE_PY;
}

/** The expensive half of the remote setup: materialize a bounded PREFIX of the
 *  dataset as `stats_data` so the shared tail can compute value statistics.
 *  Split out from remoteSetup so the DESCRIBE-only tier can reuse everything
 *  above it (types + footer row count) without paying for any row egress. */
const REMOTE_STATS_TABLE_PY = `

# Profile a BOUNDED prefix, not the whole remote dataset. A bare LIMIT reads only
# the first row groups (no full scan / no egress of the entire dataset).
#
# ...but NOT a bare star: a GEOMETRY/BLOB column is by far the fattest in the
# dataset, and pulling hundreds of thousands of rows of it over the network is
# the single thing that turns a schema probe into a timeout. OBSERVED: Overture
# division_area (8 files, full administrative boundary polygons) timed out at
# 59s on EVERY connect and starved the other 13 entities, while building
# (512 files, small bbox columns) profiled fine. The profiler never inspects
# these values (STRUCT/LIST/GEOMETRY are sampled as opaque strings), so omit the
# column from the sample entirely; the tail reports it as not-profiled, keeping
# its real name and type without inventing stats for it.
# EXACT RANGES FROM THE FOOTERS (metadata only, no data scan). min/max are what a
# prefix gets most wrong — the leading rows of a spatially sorted dataset give one
# region's range — and parquet row-group statistics carry the true whole-dataset
# min/max for free. Bounded to the same spread sample of files used for the row
# count: reading every footer of a 500-file dataset over the network is itself slow.
FOOTER_RANGES = {}
try:
    _fp_list = sample if total_files > 0 else [PATTERN]
    _fq = ", ".join("'" + f.replace("'", "''") + "'" for f in _fp_list)
    for _c, _mn, _mx in con.sql(
        f"""SELECT path_in_schema,
                   MIN(TRY_CAST(stats_min AS DOUBLE)),
                   MAX(TRY_CAST(stats_max AS DOUBLE))
            FROM parquet_metadata([{_fq}])
            WHERE stats_min IS NOT NULL AND stats_max IS NOT NULL
            GROUP BY path_in_schema"""
    ).fetchall():
        if _mn is not None and _mx is not None:
            FOOTER_RANGES[_c] = (float(_mn), float(_mx))
except Exception:
    # No footers, no statistics, or a writer that recorded none — the sample's
    # own range is used instead (the pre-existing behavior).
    FOOTER_RANGES = {}

SKIPPED_COLS = {c for c, t, *_ in describe if any(k in str(t).upper() for k in ('GEOMETRY', 'BLOB'))}
if SKIPPED_COLS:
    _kept = [c for c, _t, *_ in describe if c not in SKIPPED_COLS]
    _cols = ", ".join('"' + c.replace('"', '""') + '"' for c in _kept) or "1 AS _placeholder"
else:
    _cols = "*"
# SPREAD, don't deepen. A bare LIMIT reads the LEADING row groups, so on a dataset
# whose order correlates with its columns (Overture is sorted spatially) the sample
# is one geographic patch — a bias that does NOT shrink with depth, since 500k of
# 2.5B rows is still 0.02% of the same corner. Reading a slice from files spread
# ACROSS the listing costs the same bytes and spans the dataset instead.
#
# Per-file UNION ALL, not one LIMIT over the glob: a single LIMIT does not
# distribute across files (the same reason an OR-ed bbox kills parquet pruning),
# so the engine would just read the head again.
_spread = []
if total_files > 1:
    _want = min(SPREAD_FILES, total_files)
    _step = total_files / _want
    _spread = [files[min(int(i * _step), total_files - 1)] for i in range(_want)]
    _spread = list(dict.fromkeys(_spread))
if len(_spread) > 1:
    _per = max(1, STATS_SAMPLE_SIZE // len(_spread))
    _parts = " UNION ALL ".join(
        f"(SELECT {_cols} FROM read_parquet('" + f.replace("'", "''") + f"'{_hive_arg}) LIMIT {_per})"
        for f in _spread
    )
    con.sql(f"CREATE TEMP TABLE stats_data AS {_parts}")
    PROFILE_BASIS_KIND = 'spread_sample'
else:
    con.sql(f"CREATE TEMP TABLE stats_data AS SELECT {_cols} FROM {READ_FULL} LIMIT {STATS_SAMPLE_SIZE}")
if row_count == 0:
    row_count = con.sql("SELECT COUNT(*) FROM stats_data").fetchone()[0]
STATS_TABLE = 'stats_data'
`;

/**
 * DESCRIBE-ONLY tail: names, types and the footer row count, with NO value
 * statistics at all. Every column is reported with the `unprofiled` ColumnMeta
 * variant, so the schema is structurally complete and explicitly unmeasured.
 *
 * This is the INCLUSION FLOOR. A table only needs names and types to be usable:
 * generated SQL selects columns, it does not need their percentiles. Statistics
 * make PLANS better; they were never a precondition for access, and treating
 * them as one is what silently dropped Overture division_area from a question
 * (two 2.1-min profile failures) even though the query that answered it read
 * that table's bbox and names columns without any profile at all.
 *
 * Emits the same JSON envelope as the stats tail, so every consumer, cache and
 * registration path is identical — the two tiers differ only in `meta`.
 */
const DESCRIBE_ONLY_TAIL =
  DTYPE_MAPPER_PY +
  `
columns = []
for col_name, col_type, *_ in describe:
    columns.append({
        'name': col_name,
        'dtype': map_dtype(col_type),
        'null_count': 0,
        'sample_values': [],
        'meta': {
            'kind': 'unprofiled',
            'reason': 'schema read only — no rows were read for statistics',
        },
    })

# row_count_exact: the footer count is EXACT when every file's footer was read,
# and EXTRAPOLATED from a spread sample of footers otherwise (a 500-file dataset
# would be too slow to count footer-by-footer over the network). Reporting an
# extrapolation as exact is the kind of quiet lie this tier exists to avoid.
output = {
    'row_count': row_count,
    'row_count_exact': bool(globals().get('row_count_exact', False)),
    'columns': columns,
    'sample_rows': [],
    'correlations': None,
    'detected_domain': 'general',
    'profile_basis': {'kind': 'metadata', 'rows_examined': 0},
}
OUTPUT_PATH = globals().get('OUTPUT_PATH', '/data/output.json')
json.dump(output, open(OUTPUT_PATH, 'w'), default=str, allow_nan=False)
`;

/**
 * Build a DESCRIBE-ONLY extraction script for a remote Parquet source: types
 * from one file's schema, row count from the footers, no row egress. Seconds,
 * against the ~50s+ a value profile of the same source costs.
 */
export function buildRemoteDescribeScript(
  readUrl: string,
  authSql = "",
  isHivePartitioned = false,
  outputPath?: string
): string {
  const outputDecl = outputPath ? `OUTPUT_PATH = ${JSON.stringify(outputPath)}\n` : "";
  // Depth is irrelevant here — nothing is sampled — but the shared setup takes it.
  return remoteDescribeSetup(readUrl, authSql, isHivePartitioned) + outputDecl + DESCRIBE_ONLY_TAIL;
}

/**
 * Build the extraction script for a REMOTE cloud Parquet URL (s3:// or https://).
 * Reuses the exact same source-agnostic stats/output tail as the local path.
 * `authSql` (from duckdbRemoteAuthSql) is empty for anonymous/public access.
 */
export function buildRemoteParquetSchemaScript(
  readUrl: string,
  authSql = "",
  isHivePartitioned = false,
  /** Per-entity output path — required when extractions run CONCURRENTLY in one
   *  container, else every entity would write the same /data/output.json and
   *  results would be attributed to the wrong entity. */
  outputPath?: string,
  depth: number = DEFAULT_PROFILE_DEPTH
): string {
  const outputDecl = outputPath ? `OUTPUT_PATH = ${JSON.stringify(outputPath)}\n` : "";
  return remoteSetup(readUrl, authSql, isHivePartitioned, depth) + outputDecl + SHARED_STATS_TAIL;
}

/**
 * Source setup for a remote Parquet dataset read from the WASM WORKER (build log
 * D27). The files arrive as DuckDB aliases already bound to same-origin
 * `/api/wasm-range/<token>` URLs, so this setup deliberately omits everything the
 * container version needs and the worker must not have:
 *
 *   - NO cloud prelude / `INSTALL httpfs` — the worker's DuckDB reads the alias
 *     names, and the same-origin extension repository is wired at boot.
 *   - NO credential SQL and NO `s3_url_style` — a token IS the authorization, and
 *     the worker never learns a bucket, a region, or a key.
 *
 * Everything after this preamble is the SHARED tail, unchanged: the worker writes
 * `/data/output.json` exactly as the container does, and `worker-source.ts` already
 * returns that file as the envelope's `output`. That is why extraction in the
 * worker reuses the profiler instead of forking it.
 */
function wasmRemoteSetup(aliases: readonly string[], isHivePartitioned: boolean): string {
  if (aliases.length === 0) throw new Error("buildWasmRemoteSchemaScript: no files to read");
  // The alias list is emitted as JSON, not as hand-quoted Python. Aliases mirror
  // object-store KEY paths (that is what keeps hive columns derivable), so they are
  // user-influenced text — and SQL's escape for a quote is doubling, which inside a
  // Python literal would SILENTLY CONCATENATE instead. JSON's array-of-strings form
  // is valid Python and escapes correctly; the SQL quoting then happens in Python,
  // once, where it belongs.
  const filesJson = JSON.stringify([...aliases]);
  return `
import duckdb
import json
import math

MAX_SAMPLE_ROWS = 5
MAX_DISTINCT_VALUES = 20
MAX_TOP_VALUES = 10
MAX_CORRELATION_PAIRS = 10
# Smaller than the container's 500_000 ON PURPOSE: this sample is materialized in
# the worker's WASM heap, not a container's memory, and every row of it arrives
# over ranged reads. Stats precision is traded for a connect that finishes.
STATS_SAMPLE_SIZE = ${WASM_SCHEMA_SAMPLE_ROWS}
# Reading EVERY footer of a many-file dataset is thousands of sequential ranged
# reads through DuckDB's synchronous XHR. Bound it and extrapolate, exactly as the
# container's remote path does.
FOOTER_SAMPLE_FILES = ${WASM_SCHEMA_FOOTER_FILES}

con = duckdb.connect()

ALL_FILES = ${filesJson}
IS_HIVE = ${isHivePartitioned ? "True" : "False"}

def _sql_list(files):
    """SQL-quote a list of file names for read_parquet([...])."""
    return ", ".join("'" + f.replace("'", "''") + "'" for f in files)

READ_FULL = f"read_parquet([{_sql_list(ALL_FILES)}]" + (", hive_partitioning=true" if IS_HIVE else "") + ")"

# Schema for the dataset (partition columns included via hive when asked).
describe = con.sql(f"DESCRIBE SELECT * FROM {READ_FULL}").fetchall()

# Row count from Parquet footers — metadata only, no data pages.
try:
    total_files = len(ALL_FILES)
    if total_files <= FOOTER_SAMPLE_FILES:
        sample = ALL_FILES
    else:
        step = total_files // FOOTER_SAMPLE_FILES
        sample = [ALL_FILES[i * step] for i in range(FOOTER_SAMPLE_FILES)]
    sampled = con.sql(f"SELECT SUM(num_rows) FROM parquet_file_metadata([{_sql_list(sample)}])").fetchone()[0] or 0
    row_count = int(int(sampled) * total_files / len(sample))
except Exception:
    row_count = 0

# A bare LIMIT reads only the leading row groups — no full scan, and no egress of
# the whole dataset through the range endpoint.
con.sql(f"CREATE TEMP TABLE stats_data AS SELECT * FROM {READ_FULL} LIMIT {STATS_SAMPLE_SIZE}")
if row_count == 0:
    row_count = con.sql("SELECT COUNT(*) FROM stats_data").fetchone()[0]
STATS_TABLE = 'stats_data'
`;
}

/**
 * Build the extraction script the WASM worker runs for a remote Parquet source.
 * `aliases` are the SQL-visible names bound to range tokens (see remote-hive.ts) —
 * never URLs, never bucket keys. Reuses the same stats/output tail as the local and
 * container-remote paths.
 */
export function buildWasmRemoteSchemaScript(
  aliases: readonly string[],
  isHivePartitioned = false
): string {
  return wasmRemoteSetup(aliases, isHivePartitioned) + SHARED_STATS_TAIL;
}

/**
 * A CHEAP freshness fingerprint for a remote Parquet source: the digest of its
 * sorted file listing. Reads only the object-store LISTING (glob), never file
 * data or footers — sub-second even for a many-file dataset, versus the ~27s
 * full schema extraction. Source-agnostic: it detects change (files added /
 * removed / rewritten-with-new-names, which is how Spark/Delta/Iceberg/Hive
 * writers emit data) without knowing anything about the dataset. An immutable
 * source yields a stable digest and therefore free caching — detected, not
 * assumed. (Blind spot: a same-filename in-place byte overwrite; the manual
 * refresh / ignore-cache controls cover it.)
 */
export function buildParquetFingerprintScript(readUrl: string, authSql = ""): string {
  const url = normalizeRemoteParquetUrl(readUrl);
  const auth = authSql ? `con.sql("${authSql}")\n` : "";
  return `
import duckdb
import json

con = duckdb.connect()
con.sql("${DUCKDB_CLOUD_PRELUDE}")
${S3_URL_STYLE_FROM_ENV_PY}${auth}
row = con.sql(
    "SELECT coalesce(md5(string_agg(file, chr(10) ORDER BY file)), 'empty') AS fp, "
    "count(*) AS n FROM glob('${url}')"
).fetchone()

with open('/data/output.json', 'w') as f:
    json.dump({"fp": row[0], "n": int(row[1])}, f)
`;
}

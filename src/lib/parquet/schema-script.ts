import { LOCAL_MOUNT_PATH } from "@/lib/constants";

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
const SHARED_STATS_TAIL = `
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

for ci in columns_info:
    col_name = ci['name']
    dtype = ci['dtype']
    escaped = col_name.replace('"', '""')
    q = f'"{escaped}"'

    # Null count (on sample for speed)
    null_count = con.sql(f"SELECT COUNT(*) FILTER ({q} IS NULL) FROM {STATS_TABLE}").fetchone()[0]

    # Sample values
    sample_vals = con.sql(
        f"SELECT CAST({q} AS VARCHAR) FROM {STATS_TABLE} WHERE {q} IS NOT NULL LIMIT {MAX_SAMPLE_ROWS}"
    ).fetchall()
    sample_values = [str(r[0]) for r in sample_vals]

    meta = None

    if dtype == 'number':
        numeric_cols.append(col_name)
        row = con.sql(f"""
            SELECT
                MIN({q}),
                MAX({q}),
                AVG({q}),
                MEDIAN({q}),
                STDDEV({q}),
                PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY {q}),
                PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY {q}),
                COUNT(*) FILTER ({q} = 0),
                COUNT(*) FILTER ({q} < 0),
                SKEWNESS({q}),
                KURTOSIS({q}),
                COUNT(*) FILTER ({q} IS NULL) * 100.0 / NULLIF(COUNT(*), 0)
            FROM {STATS_TABLE}
        """).fetchone()

        p25 = safe_float(row[5]) or 0
        p75 = safe_float(row[6]) or 0
        iqr = p75 - p25

        # Outlier count via IQR method
        if iqr > 0:
            outlier_count = con.sql(f"""
                SELECT COUNT(*) FROM {STATS_TABLE}
                WHERE {q} < {p25 - 1.5 * iqr} OR {q} > {p75 + 1.5 * iqr}
            """).fetchone()[0]
        else:
            outlier_count = 0

        # Detect integer vs float
        is_integer = 'INT' in ci['duckdb_type'].upper()
        decimal_precision = 0 if is_integer else 2

        meta = {
            'kind': 'number',
            'is_integer': is_integer,
            'decimal_precision': decimal_precision,
            'is_currency': False,
            'is_percentage': False,
            'min': safe_float(row[0]) or 0,
            'max': safe_float(row[1]) or 0,
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
        row = con.sql(f"""
            SELECT
                MIN({q}),
                MAX({q})
            FROM {STATS_TABLE}
        """).fetchone()

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
        row = con.sql(f"""
            SELECT
                COUNT(*) FILTER ({q} = TRUE),
                COUNT(*) FILTER ({q} = FALSE)
            FROM {STATS_TABLE}
        """).fetchone()

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
        distinct_count = con.sql(f"SELECT COUNT(DISTINCT {q}) FROM {STATS_TABLE}").fetchone()[0]

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

        # String length stats
        len_row = con.sql(f"""
            SELECT
                AVG(LENGTH(CAST({q} AS VARCHAR))),
                MAX(LENGTH(CAST({q} AS VARCHAR))),
                MIN(LENGTH(CAST({q} AS VARCHAR)))
            FROM {STATS_TABLE}
            WHERE {q} IS NOT NULL
        """).fetchone()

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

    for col_a, col_b in pairs:
        ea = col_a.replace('"', '""')
        eb = col_b.replace('"', '""')
        try:
            r = con.sql(f"""
                SELECT CORR("{ea}", "{eb}")
                FROM {STATS_TABLE}
            """).fetchone()[0]
            if r is not None and not math.isnan(r):
                correlations.append({
                    'col_a': col_a,
                    'col_b': col_b,
                    'pearson': round(float(r), 4),
                })
        except Exception:
            pass

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
output = {
    'row_count': row_count,
    'columns': columns,
    'sample_rows': sample_rows,
    'correlations': correlations if correlations else None,
    'detected_domain': detected_domain,
}

json.dump(output, open('/data/output.json', 'w'), default=str, allow_nan=False)
`;

/** Source setup for a LOCAL Parquet file or folder (bind-mounted at /data/local).
 *  Produces con / describe / row_count / stats_data + the MAX_* constants. */
function localSetup(filename: string, isFolder: boolean, isHivePartitioned?: boolean): string {
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
STATS_SAMPLE_SIZE = 500_000

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
  isHivePartitioned?: boolean
): string {
  return localSetup(filename, isFolder, isHivePartitioned) + SHARED_STATS_TAIL;
}

/** Source setup for a REMOTE cloud Parquet URL (s3:// or https://), read directly
 *  via DuckDB httpfs. Loads the cloud/geo extensions, takes the row count from
 *  Parquet FOOTERS (metadata only, no data scan — critical over the network), and
 *  profiles a bounded prefix of the data. `readUrl` MUST be a pre-validated URL
 *  (see isSafeParquetUrl) — it is interpolated into the DuckDB SQL. */
function remoteSetup(readUrl: string, authSql: string, isHivePartitioned = false): string {
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
STATS_SAMPLE_SIZE = 500_000
FOOTER_SAMPLE_FILES = 32

con = duckdb.connect()
con.sql("${DUCKDB_CLOUD_PRELUDE}")
${S3_URL_STYLE_FROM_ENV_PY}${auth}
PATTERN = '${url}'
READ_FULL = "${readExpr}"

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
except Exception:
    row_count = 0

# Profile a BOUNDED prefix, not the whole remote dataset. A bare LIMIT reads only
# the first row groups (no full scan / no egress of the entire dataset).
con.sql(f"CREATE TEMP TABLE stats_data AS SELECT * FROM {READ_FULL} LIMIT {STATS_SAMPLE_SIZE}")
if row_count == 0:
    row_count = con.sql("SELECT COUNT(*) FROM stats_data").fetchone()[0]
STATS_TABLE = 'stats_data'
`;
}

/**
 * Build the extraction script for a REMOTE cloud Parquet URL (s3:// or https://).
 * Reuses the exact same source-agnostic stats/output tail as the local path.
 * `authSql` (from duckdbRemoteAuthSql) is empty for anonymous/public access.
 */
export function buildRemoteParquetSchemaScript(
  readUrl: string,
  authSql = "",
  isHivePartitioned = false
): string {
  return remoteSetup(readUrl, authSql, isHivePartitioned) + SHARED_STATS_TAIL;
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

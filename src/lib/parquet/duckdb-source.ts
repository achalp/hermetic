/**
 * Single source of truth for "how does the sandbox read this Parquet/CSV dataset
 * via DuckDB, and what do we tell code-gen about it". Both the Ask route and the
 * Investigate route used to hand-build near-identical `read_parquet(...)`
 * expressions and "Data Location" prose; that lived in two places and drifted.
 * It lives here now, so a change (or a new source kind like remote cloud Parquet)
 * lands once.
 */
import "server-only";
import { basename, dirname } from "node:path";
import { LOCAL_MOUNT_PATH } from "@/lib/constants";
import type { StoredCSV, RemoteCreds } from "@/lib/types";

export type { RemoteCreds };

/** Rows above which we must push aggregation into DuckDB before `.df()`. */
const LARGE_ROWS = 1_000_000;

/**
 * DuckDB prelude to enable reading cloud files (httpfs → s3://, https://) and
 * spatial/geo ops (spatial). The sandbox image pre-bundles both, so LOAD is
 * offline + instant; INSTALL stays as a fallback for a runtime that didn't
 * pre-bundle (it's a no-op when the extension is already present).
 */
export const DUCKDB_CLOUD_PRELUDE = "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;";

/**
 * Python that runs the prelude on a DuckDB connection before any remote read.
 * `con` is the DuckDB connection variable name in the generated script.
 */
export function duckdbCloudPreludePy(con = "duckdb"): string {
  return `${con}.sql("${DUCKDB_CLOUD_PRELUDE}")`;
}

/** A DuckDB `read_parquet(...)` expression for a path OR a remote URL (s3://,
 *  https://). Hive-partitioned folders add the flag so partition columns surface. */
export function parquetReadExpr(pathOrUrl: string, hivePartitioned = false): string {
  return `read_parquet('${pathOrUrl}'${hivePartitioned ? ", hive_partitioning=true" : ""})`;
}

/**
 * SSRF guard for http(s) Parquet URLs, which the server fetches on the user's
 * behalf (schema extraction + the sandbox read). Rejects hosts that are
 * internal by construction: loopback, link-local (incl. the 169.254.169.254
 * cloud metadata endpoint), RFC-1918 / CGNAT ranges, all-numeric IP encodings,
 * IPv6 literals, and *.internal names. Object-store schemes (s3://, gs://, …)
 * name a bucket, not a network host, so they pass through — the fetch goes to
 * the provider. Scope note: this rejects literal/known-internal addresses; it
 * does not pin DNS (a hostname that RESOLVES to an internal address at fetch
 * time is out of reach here since DuckDB httpfs does its own resolution).
 */
function isBlockedHttpHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal" || h.endsWith(".internal")) return true;
  // IPv6 literal (URL keeps brackets) — loopback/link-local/ULA all rejected.
  if (h.startsWith("[")) return true;
  // All-digit single-label host = decimal/octal IP encoding (http://2130706433/).
  if (/^\d+$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127 || a === 10 || a === 0) return true; // loopback, RFC-1918, "this net"
    if (a === 169 && b === 254) return true; // link-local / metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
    if (a === 192 && b === 168) return true; // RFC-1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

/**
 * Whether a user-supplied cloud-Parquet URL is safe to interpolate into DuckDB
 * SQL. The URL lands inside a single-quoted `read_parquet('...')` literal, so we
 * hard-reject any character that could break out of it or inject (quotes,
 * backslash, backtick, semicolon, control chars) and require a known object-store
 * / http(s) scheme. http(s) hosts additionally pass the SSRF guard above.
 * A glob (`*`) and query string are allowed. Reject-by-default.
 */
export function isSafeParquetUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (!/^(s3|s3a|gs|gcs|az|azure|abfss?|https?):\/\//i.test(url)) return false;
  if (/['"`\\;\n\r\t\0]/.test(url)) return false;
  if (/^https?:\/\//i.test(url)) {
    try {
      if (isBlockedHttpHost(new URL(url).hostname)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** A credential token safe to interpolate into a single-quoted SQL literal. */
function safeCredValue(v: unknown): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 512) return null;
  // Keys/regions/endpoints are alphanumerics + a small punctuation set; a quote,
  // backslash, semicolon, or control char is never legitimate here.
  if (/['"`\\;\n\r\t\0]/.test(v)) return null;
  return v;
}

/**
 * DuckDB SQL to authenticate cloud reads. Anonymous by default (returns just a
 * region SET when given, else empty — httpfs reads public https/s3 with no
 * secret). When an access key + secret are provided, creates an S3 secret.
 * Reject-by-default on any unsafe credential token (returns empty rather than
 * risk an injection).
 */
export function duckdbRemoteAuthSql(creds?: RemoteCreds): string {
  if (!creds) return "";
  const key = safeCredValue(creds.s3AccessKeyId);
  const secret = safeCredValue(creds.s3SecretAccessKey);
  const region = creds.s3Region ? safeCredValue(creds.s3Region) : null;
  const endpoint = creds.s3Endpoint ? safeCredValue(creds.s3Endpoint) : null;

  if (key && secret) {
    const parts = [`TYPE s3`, `KEY_ID '${key}'`, `SECRET '${secret}'`];
    if (region) parts.push(`REGION '${region}'`);
    if (endpoint) parts.push(`ENDPOINT '${endpoint}'`);
    return `CREATE OR REPLACE SECRET hermetic_s3 (${parts.join(", ")});`;
  }
  // Anonymous: a region helps s3:// resolve; https needs nothing.
  return region ? `SET s3_region='${region}';` : "";
}

/**
 * Code-gen "Data Location" context for a REMOTE cloud Parquet source read
 * directly via DuckDB httpfs. Reuses the same folder/file context builders as
 * the local path (so a globbed folder gets the "create a view, materialize the
 * filtered subset first" guidance) and prepends the cloud/geo extension prelude.
 *
 * `url` is the already-normalized read expression (see normalizeRemoteParquetUrl):
 * a glob for a folder/Hive dataset, or a single-file URL. Caller MUST have
 * validated the original input (isSafeParquetUrl).
 */
export function resolveRemoteSource(
  url: string,
  rowCount: number,
  isHivePartitioned = false,
  creds?: RemoteCreds
): { localFileContext: string } {
  const isFolder = url.includes("*");
  const readExpr = parquetReadExpr(url, isHivePartitioned);
  const authSql = duckdbRemoteAuthSql(creds);
  const authLine = authSql ? ` then authenticate: duckdb.sql("${authSql}");` : "";
  const prelude = `FIRST, enable cloud + geo reads once at the top of the script: ${duckdbCloudPreludePy()}${authLine}\n`;
  const body = isFolder
    ? parquetFolderContext(readExpr, rowCount, isHivePartitioned)
    : parquetFileContext(readExpr, url, rowCount);
  return { localFileContext: prelude + body + remoteNetworkNote(readExpr) };
}

/**
 * Remote-only guidance: reading over the network is slow and costs egress, and a
 * naive script re-scans the remote files once per aggregation. Steer code-gen to
 * pull the needed columns into a LOCAL temp table in a SINGLE pass, then query
 * that — and to leave the heavy geometry/nested columns behind unless asked for.
 */
function remoteNetworkNote(readExpr: string): string {
  return (
    `\nNETWORK COST — reading over the network is the dominant cost, and it scales with COLUMNS × ROWS, not rows alone. ` +
    `One WIDE column (a 32-char id, a name, a WKB geometry) read for millions of rows dwarfs the numeric filtering. ` +
    `Measured on a California-buildings scan: reading only the bbox/coordinate columns took ~3 min; adding the id ` +
    `column pushed it to 8+ min; adding all the display columns (id/class/subtype/height) blew past a 20-min timeout. So:\n` +
    `(1) ONE big remote pass, and it materializes ONLY the columns needed to FILTER and RANK — numeric/coordinate ` +
    `columns — and NOTHING purely for display. NEVER geometry/struct/list/map, and NOT id/name/class/etc. for all rows:\n` +
    `  duckdb.sql("CREATE TEMP TABLE t AS SELECT <only the numeric columns needed to compute the answer> FROM ${readExpr} WHERE <filters>")\n` +
    `Do NOT add \`row_number() OVER ()\` or any un-partitioned/global window to this pass — it is a single-threaded ` +
    `PIPELINE BREAKER that funnels the entire scan through one thread and throttles the remote read (measured: it ` +
    `turned a ~4-min California materialize into an 18-min+ timeout). You do not need a key: pull the coordinates ` +
    `to pandas and use the DataFrame's positional index; the top-N are row positions and you hydrate by coordinate (3).\n` +
    `(2) Run every aggregation/ranking against the LOCAL table t, never the remote read again for the full set.\n` +
    `(3) HYDRATE display columns (id, name, class, height, ...) for ONLY the final top-N rows with a SECOND remote ` +
    `read that is cheaply PRUNED — filter it by a SMALL bbox around each top-N point (bbox predicate-pushdown skips ` +
    `every other file), NOT by an unindexed \`id IN (...)\` over the whole dataset (that re-scans everything). Then ` +
    `match the handful of returned rows back to your top-N by nearest coordinate. Example for spatial top-N:\n` +
    `  # top_pts = [(lon,lat), ...] for the N winners; e ~= 0.02 deg\n` +
    `  boxes = " OR ".join(f"(bbox.xmin BETWEEN {lo-0.02} AND {lo+0.02} AND bbox.ymin BETWEEN {la-0.02} AND {la+0.02})" for lo,la in top_pts)\n` +
    `  duckdb.sql(f"SELECT id, class, height, (bbox.xmin+bbox.xmax)/2 lon, (bbox.ymin+bbox.ymax)/2 lat FROM ${readExpr} WHERE {boxes}").df()\n` +
    `The expensive full pass stays numeric-only; the only wide-column read is over a handful of rows.`
  );
}

/**
 * Classify-first scan strategy for a LARGE Parquet dataset (geo AND non-geo).
 * On a big/remote source the READ is the dominant cost, so the amount of data
 * the answer actually depends on dictates the approach. Teaches the model to
 * pick a category before scanning — the general form of the two-phase geometry
 * read and the numeric-first-then-hydrate pass: read the CHEAP thing to
 * ELIMINATE, read the EXPENSIVE thing only for what survives. `readExpr` is the
 * read_parquet(...) expression; the parquet_metadata path is pulled from it.
 */
function scanStrategyNote(readExpr: string): string {
  const path = readExpr.match(/read_parquet\('([^']+)'/)?.[1] ?? "<the same path/glob>";
  return (
    `\nSCAN STRATEGY — classify the question BEFORE you scan, because how much of the data the answer needs decides the approach (this applies to ANY column, geo or not):\n` +
    `(A) EXTREME / SELECTIVE — the answer is a FEW rows with an extreme property (tallest, largest, oldest, rarest, most-isolated, top-N by some measure). Do NOT read every row: eliminate the majority that provably cannot win using CHEAP per-row-group statistics, then scan only the survivors.\n` +
    `   • Ranking on a STORED numeric/date column (height, amount, timestamp): use Parquet ZONE MAPS — parquet_metadata('${path}') returns per-row-group stats_min/stats_max for every column straight from the file FOOTERS (no data scan; seconds even over billions of rows). For a MAX query, skip every row group whose stats_max(col) is below the best candidate so far; scan only the row groups that could hold the winner. Exact and near-free.\n` +
    `   • Ranking on a DERIVED property not stored as a column (spatial isolation, largest gap between consecutive events): use a cheap PROXY from the same metadata — e.g. for a most-isolated point, density = row_group_num_rows / bbox-extent-area, so the winner must be in a LOW-density row group; scan only that sparse tail (full spatial recipe in the geospatial section).\n` +
    `(B) METADATA-ONLY AGGREGATE — COUNT(*), MIN(col), MAX(col), the value range/extent: answer straight from parquet_metadata footers (COUNT(*) = SUM(row_group_num_rows); MIN/MAX = min/max of the per-row-group stats). NO data scan at all.\n` +
    `(C) HOLISTIC AGGREGATE — AVG, MEDIAN, SUM, COUNT(DISTINCT), a full distribution or per-group rollup: every row contributes, footer stats cannot give these, so you must scan them all. If that fits the budget, one SQL pass over ONLY the needed numeric columns. If it does NOT (e.g. a global average over billions of remote rows), compute over a bounded/disclosed scope or a uniform sample and say so in results["analysis_scope"] — never pass a partial off as the whole.\n`
  );
}

/** The "reduce in SQL, never SELECT * unaggregated" guidance appended for a large
 *  dataset — shared so the wording is identical everywhere. */
function largeDataNote(rowCount: number): string {
  return (
    `CRITICAL: This is a large dataset (${rowCount.toLocaleString()} rows). You MUST use DuckDB SQL ` +
    `with WHERE, GROUP BY, or LIMIT to reduce data BEFORE calling .df(). NEVER SELECT * without a LIMIT ` +
    `or aggregation. Aggregate in SQL, convert only the small result to pandas. Keep total queries to 3 ` +
    `or fewer — combine aggregations into a single query when possible.\n`
  );
}

/** Code-gen "Data Location" context for a FOLDER of Parquet shards (read via a view). */
export function parquetFolderContext(readExpr: string, rowCount: number, hive: boolean): string {
  return (
    `This is a ${hive ? "Hive-partitioned " : ""}folder of Parquet files.\n` +
    `Total rows: ${rowCount.toLocaleString()}.\n` +
    `FIRST, create a DuckDB view ONCE at the top of the script:\n` +
    `  duckdb.sql("CREATE OR REPLACE VIEW data AS SELECT * FROM ${readExpr}")\n` +
    `Then query the view. If the question targets a subset (e.g. specific users, date range), ` +
    `materialize the filtered subset into a temp table FIRST for speed:\n` +
    `  duckdb.sql("CREATE TEMP TABLE filtered AS SELECT * FROM data WHERE ...")\n` +
    `  Then run all subsequent queries against 'filtered' instead of 'data'.\n` +
    (hive
      ? `Partition columns (e.g. year, month) are automatically available as columns via Hive partitioning. USE them in WHERE clauses to filter efficiently.\n`
      : "") +
    (rowCount > LARGE_ROWS ? largeDataNote(rowCount) + scanStrategyNote(readExpr) : "") +
    `Do NOT read from /data/input.csv — the data is in Parquet format.\n` +
    `Do NOT use pd.read_parquet() — use duckdb.sql() for this dataset.`
  );
}

/** Code-gen "Data Location" context for a SINGLE Parquet file. */
export function parquetFileContext(readExpr: string, where: string, rowCount: number): string {
  return (
    `This is a Parquet file at ${where} (${rowCount.toLocaleString()} rows).\n` +
    `Read with: duckdb.sql("SELECT * FROM ${readExpr}").df()\n` +
    (rowCount > LARGE_ROWS ? largeDataNote(rowCount) + scanStrategyNote(readExpr) : "") +
    `Do NOT read from /data/input.csv — the data is in Parquet at ${where}.`
  );
}

/** Code-gen "Data Location" context for a single mounted CSV/other file. */
function csvFileContext(fname: string): string {
  const p = `${LOCAL_MOUNT_PATH}/${fname}`;
  return (
    `The data file is mounted at ${p}.\n` +
    `Read with: pd.read_csv("${p}")\n` +
    `Do NOT read from /data/input.csv — the data is at ${p}.`
  );
}

/**
 * Resolve a browsed LOCAL-file source into (a) the host path to bind-mount and
 * (b) the code-gen "Data Location" context. Shared by both query routes. Returns
 * empty for a non-local (upload/warehouse) source.
 *
 * Mount strategy (unchanged): a folder mounts itself; a single file mounts its
 * parent directory (so the file lands at /data/local/<name>).
 */
export function resolveLocalSource(stored: StoredCSV): {
  localMountPath?: string;
  localFileContext?: string;
} {
  if (stored.localFolderPath) {
    const readExpr = parquetReadExpr(
      `${LOCAL_MOUNT_PATH}/**/*.parquet`,
      !!stored.isHivePartitioned
    );
    return {
      localMountPath: stored.localFolderPath,
      localFileContext: parquetFolderContext(
        readExpr,
        stored.schema.row_count,
        !!stored.isHivePartitioned
      ),
    };
  }
  if (stored.localPath) {
    const fname = basename(stored.localPath);
    const where = `${LOCAL_MOUNT_PATH}/${fname}`;
    const isParquet = fname.toLowerCase().endsWith(".parquet") || !!stored.isParquet;
    return {
      localMountPath: dirname(stored.localPath),
      localFileContext: isParquet
        ? parquetFileContext(parquetReadExpr(where), where, stored.schema.row_count)
        : csvFileContext(fname),
    };
  }
  return {};
}

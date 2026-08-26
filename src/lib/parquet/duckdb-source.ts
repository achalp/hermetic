/**
 * Single source of truth for "how does the sandbox read this Parquet/CSV dataset
 * via DuckDB, and what do we tell code-gen about it". Both the Ask route and the
 * Investigate route used to hand-build near-identical `read_parquet(...)`
 * expressions and "Data Location" prose; that lived in two places and drifted.
 * It lives here now, so a change (or a new source kind like remote cloud Parquet)
 * lands once.
 */
import { basename, dirname } from "node:path";
import { LOCAL_MOUNT_PATH } from "@/lib/constants";
import type { StoredCSV, RemoteCreds } from "@/lib/contracts/storage-types";

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

/**
 * Normalize a REMOTE parquet URL for reading. A bare directory/prefix URL — e.g.
 * `s3://overturemaps-us-west-2/release/…/type=building` — is NOT a file: DuckDB
 * resolves it to a single non-existent object → 404 / "No files found". Append the
 * recursive parquet glob so a hive-partitioned prefix reads the whole dataset,
 * matching how the analysis path reads it. Explicit files (`…/x.parquet`) and URLs
 * that already contain a glob (`*`) are left untouched; non-remote paths (no
 * `://`) pass through (local hive dirs are globbed separately by the caller).
 * This is why "reopen recent" failed: recent sources store the prefix, but the
 * schema extraction read it raw.
 */
export function normalizeRemoteParquetUrl(url: string): string {
  if (!url.includes("://") || /\.parquet$/i.test(url) || url.includes("*")) return url;
  return url.replace(/\/+$/, "") + "/**/*.parquet";
}

/** A DuckDB `read_parquet(...)` expression for a path OR a remote URL (s3://,
 *  https://). A bare remote directory/prefix is normalized to the recursive glob
 *  (see normalizeRemoteParquetUrl) so it reads instead of 404-ing. Hive-partitioned
 *  folders add the flag so partition columns surface. */
export function parquetReadExpr(pathOrUrl: string, hivePartitioned = false): string {
  const p = normalizeRemoteParquetUrl(pathOrUrl);
  return `read_parquet('${p}'${hivePartitioned ? ", hive_partitioning=true" : ""})`;
}

/**
/**
 * Parse a host as an IPv4 address the way the OS resolver (inet_aton) does:
 * 1–4 parts, each decimal / 0x-hex / 0-octal; a short form's LAST part fills the
 * remaining low bytes. Returns the 32-bit address (>>>0) or null when the host
 * is not a numeric IPv4 in any of these forms. This is what makes `127.1`,
 * `0x7f000001`, `0177.0.0.1`, and `2130706433` all resolve to 127.0.0.1 — the
 * denylist below must normalize the same way or those shorthands slip past it
 * (finding H2).
 */
export function parseLooseIPv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^0$/.test(p) || /^[1-9][0-9]*$/.test(p)) n = parseInt(p, 10);
    else return null; // empty, leading-zero-non-octal ("08"), or non-numeric
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }
  const k = nums.length;
  // Every part but the last is one byte; the last fills the remaining bytes.
  for (let i = 0; i < k - 1; i++) if (nums[i] > 0xff) return null;
  const lastBytes = 4 - (k - 1);
  if (nums[k - 1] >= 2 ** (8 * lastBytes)) return null;
  let addr = 0;
  for (let i = 0; i < k - 1; i++) addr = addr * 256 + nums[i];
  addr = addr * 2 ** (8 * lastBytes) + nums[k - 1];
  return addr > 0xffffffff ? null : addr >>> 0;
}

/** True when a 32-bit IPv4 address is in a loopback/private/link-local range. */
function isBlockedIPv4(addr: number): boolean {
  const a = (addr >>> 24) & 0xff;
  const b = (addr >>> 16) & 0xff;
  if (a === 127 || a === 10 || a === 0) return true; // loopback, RFC-1918, "this net"
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * SSRF guard for http(s) Parquet URLs, which the server fetches on the user's
 * behalf (schema extraction + the sandbox read). Rejects hosts that are
 * internal by construction: loopback, link-local (incl. the 169.254.169.254
 * cloud metadata endpoint), RFC-1918 / CGNAT ranges, IPv4 in ANY inet_aton
 * encoding (dotted / short / hex / octal / integer — finding H2), IPv6
 * literals, and *.internal names. Object-store schemes (s3://, gs://, …) name a
 * bucket, not a network host, so they pass through — the fetch goes to the
 * provider. Scope note: this rejects literal/known-internal addresses; it does
 * not pin DNS (a hostname that RESOLVES to an internal address at fetch time is
 * out of reach here since DuckDB httpfs does its own resolution).
 *
 * Exported so the egress allowlist derivation applies the SAME check to the
 * hosts it would open a proxy toward (finding M2) — a custom `s3Endpoint` or an
 * `https://` source host must not be a metadata / RFC-1918 / loopback target.
 */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "metadata.google.internal" || h.endsWith(".internal")) return true;
  // IPv6 literal (URL keeps brackets) — loopback/link-local/ULA all rejected.
  if (h.startsWith("[")) return true;
  const addr = parseLooseIPv4(h);
  if (addr !== null) return isBlockedIPv4(addr);
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
  if (/[,'"`\\;\n\r\t\0]/.test(url)) return false;
  if (/^https?:\/\//i.test(url)) {
    try {
      if (isInternalHostname(new URL(url).hostname)) return false;
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
 * Opaque tokens that stand in for the real S3 key/secret in the code-gen PROMPT
 * (finding C1). The prompt (and therefore the LLM provider, which for a remote
 * model is off-machine) must NEVER carry the real bucket credentials, so the
 * `CREATE SECRET` line the model is asked to reproduce uses these placeholders;
 * the real values are substituted back into the generated code at the executor
 * boundary via `applyRemoteAuth`, never into anything logged, persisted, or fed
 * back into a retry prompt. The tokens are quote/backslash-free so they can't
 * break out of the single-quoted SQL literal they sit inside.
 */
export const S3_KEY_ID_PLACEHOLDER = "__HERMETIC_S3_KEY_ID__";
export const S3_SECRET_PLACEHOLDER = "__HERMETIC_S3_SECRET__";

/** Real credential values to splice into the executed code (executor boundary only). */
export interface RemoteAuthSubst {
  keyId: string;
  secret: string;
}

/**
 * DuckDB SQL to authenticate cloud reads. Anonymous by default (returns just a
 * region SET when given, else empty — httpfs reads public https/s3 with no
 * secret). When an access key + secret are provided, creates an S3 secret.
 * Reject-by-default on any unsafe credential token (returns empty rather than
 * risk an injection).
 *
 * `placeholders`: emit the opaque KEY_ID/SECRET tokens instead of the real
 * values. Used for the code-gen prompt so no real credential leaves the machine
 * (finding C1); the real values are restored by `applyRemoteAuth` at execution.
 */
export function duckdbRemoteAuthSql(creds?: RemoteCreds, placeholders = false): string {
  if (!creds) return "";
  const key = safeCredValue(creds.s3AccessKeyId);
  const secret = safeCredValue(creds.s3SecretAccessKey);
  const region = creds.s3Region ? safeCredValue(creds.s3Region) : null;
  const endpoint = creds.s3Endpoint ? safeCredValue(creds.s3Endpoint) : null;

  if (key && secret) {
    const keyLit = placeholders ? S3_KEY_ID_PLACEHOLDER : key;
    const secretLit = placeholders ? S3_SECRET_PLACEHOLDER : secret;
    const parts = [`TYPE s3`, `KEY_ID '${keyLit}'`, `SECRET '${secretLit}'`];
    if (region) parts.push(`REGION '${region}'`);
    if (endpoint) parts.push(`ENDPOINT '${endpoint}'`);
    return `CREATE OR REPLACE SECRET hermetic_s3 (${parts.join(", ")});`;
  }
  // Anonymous: a region helps s3:// resolve; https needs nothing.
  return region ? `SET s3_region='${region}';` : "";
}

/**
 * The real key/secret substitution for a source, or `undefined` when the source
 * is anonymous or a credential value is unsafe (reject-by-default, matching
 * `duckdbRemoteAuthSql`). Kept OUT of the prompt — carried alongside it and
 * applied only at the executor boundary.
 */
export function remoteAuthSubst(creds?: RemoteCreds): RemoteAuthSubst | undefined {
  if (!creds) return undefined;
  const keyId = safeCredValue(creds.s3AccessKeyId);
  const secret = safeCredValue(creds.s3SecretAccessKey);
  if (!keyId || !secret) return undefined;
  return { keyId, secret };
}

/**
 * Restore real S3 credentials into generated code immediately before it is
 * handed to the sandbox (finding C1). A no-op when `subst` is absent (local /
 * anonymous / warehouse sources) or the code carries no placeholder. Must be
 * applied ONLY to the copy sent to the executor — never to the `code` retained
 * for retry prompts or the forensic record, both of which must stay cred-free.
 */
export function applyRemoteAuth(code: string, subst?: RemoteAuthSubst): string {
  if (!subst) return code;
  return code
    .split(S3_KEY_ID_PLACEHOLDER)
    .join(subst.keyId)
    .split(S3_SECRET_PLACEHOLDER)
    .join(subst.secret);
}

/**
 * Scrub S3 secret literals out of a generated script BEFORE it is logged or
 * persisted (finding M1). duckdbRemoteAuthSql embeds `KEY_ID '<key>'` and
 * `SECRET '<secret>'` into the model-authored SQL, and both the "Remote cloud
 * execution" log (logged whole via meta.fullCode, which the logger's key-name
 * redaction does not cover) and the persisted attempt-code record would
 * otherwise carry the raw credentials. Only the quoted VALUES are replaced, so
 * the script stays readable for debugging; the `CREATE OR REPLACE SECRET <name>`
 * keyword (no adjacent quote) is untouched. Idempotent and a no-op for scripts
 * without a secret.
 */
export function redactRemoteSecrets(code: string): string {
  return code.replace(/\b(KEY_ID|SECRET)(\s+)'[^']*'/gi, "$1$2'[redacted]'");
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
): { localFileContext: string; remoteAuthSubst?: RemoteAuthSubst } {
  const isFolder = url.includes("*");
  const readExpr = parquetReadExpr(url, isHivePartitioned);
  // The prompt carries the auth line with PLACEHOLDER credentials only — the
  // real key/secret rides alongside as `remoteAuthSubst` and is spliced into the
  // generated code at the executor boundary (finding C1), so no real credential
  // ever reaches the (possibly off-machine) code-gen model.
  const authSql = duckdbRemoteAuthSql(creds, true);
  const authLine = authSql ? ` then authenticate: duckdb.sql("${authSql}");` : "";
  const prelude = `FIRST, enable cloud + geo reads once at the top of the script: ${duckdbCloudPreludePy()}${authLine}\n`;
  const body = isFolder
    ? parquetFolderContext(readExpr, rowCount, isHivePartitioned)
    : parquetFileContext(readExpr, url, rowCount);
  return {
    localFileContext: prelude + body + remoteNetworkNote(readExpr),
    remoteAuthSubst: remoteAuthSubst(creds),
  };
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
    `column pushed it to ~8 min. So:\n` +
    `(1) ONE big pass into a LOCAL temp table t, filtered to the analysis SCOPE (a named region / bbox subset). Run ` +
    `every aggregation/ranking against t afterwards — never the remote read again for the full set:\n` +
    `  duckdb.sql("CREATE TEMP TABLE t AS SELECT <cols> FROM ${readExpr} WHERE <region filters>")\n` +
    `Do NOT add \`row_number() OVER ()\` or any un-partitioned/global window to this pass — it is a single-threaded ` +
    `PIPELINE BREAKER that throttles the remote read (measured: it turned a ~4-min California materialize into an ` +
    `18-min+ timeout). Use DuckDB's FREE implicit \`rowid\` as the key, never a manufactured one.\n` +
    `(2) For the KD-tree (or ANY pandas frame) pull ONLY numeric columns — \`duckdb.sql("SELECT rowid, lon, lat FROM t").df()\` — ` +
    `NEVER id/name/strings into pandas (that is the OOM). The DataFrame's positions carry rowid, so the top-N positions give you their rowids.\n` +
    `(3) HYDRATE the top-N winners' display columns (id, name, class, height, ...). The split that matters:\n` +
    `  • BOUNDED region (t already holds every candidate row — the USUAL case, e.g. a named region): include the display ` +
    `columns IN t in step (1) — t is a bounded subset, so wide-cols × bounded-rows is affordable — and hydrate the winners ` +
    `LOCALLY by rowid, NO second remote read: \`duckdb.sql(f"SELECT * FROM t WHERE rowid IN ({top_ids})").df()\`.\n` +
    `  • DO NOT hydrate a most-isolated / sparse-tail top-N via a second REMOTE bbox read: the winners of an ISOLATION query ` +
    `sit in WIDE-SPAN row groups whose huge extent defeats bbox predicate-pushdown, so a "small bbox per winner" remote read ` +
    `re-reads those big row groups and TIMES OUT (measured: California hydration blew the 20-min budget exactly this way). ` +
    `For a bounded region always hydrate locally from t by rowid (above).\n` +
    `  • ONLY when the scan is genuinely UNBOUNDED (no region — t cannot hold wide columns for billions of rows) fall back to ` +
    `a second bbox-pruned remote read for the top-N (\`... WHERE {small per-winner boxes}\`), accepting it is the slow tail.`
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
    `or fewer — combine aggregations into a single query when possible.\n` +
    `PROGRESS: a long run streams live progress to the user. Call progress("<what you are doing>") ` +
    `(auto-injected, no import) at each PHASE boundary — e.g. progress("scanning buildings"), ` +
    `progress("building KD-tree"), progress("hydrating winners") — and pass rows=/total_rows= or ` +
    `fraction=0..1 when you know them. An elapsed heartbeat is emitted automatically; these labels make ` +
    `it MEANINGFUL. This is progress reporting only — it never changes results.\n`
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

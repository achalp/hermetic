/**
 * Convention-based recognition of how Parquet datasets are laid out — shared by
 * the LOCAL file browser (which walks the filesystem) and the REMOTE cloud
 * source (which can only inspect the URL). Keeping the conventions in one
 * fs-free module means "what counts as Hive-partitioned" is defined exactly
 * once.
 *
 * The conventions covered are the near-universal ones for object-store Parquet
 * lakes (Spark, Hive, Athena, Trino, DuckDB COPY ... PARTITION_BY, and public
 * datasets like Overture Maps):
 *   - a single ".parquet" file
 *   - a flat folder of "part-*.parquet" shards
 *   - Hive partitioning: nested "key=value" directories (e.g. Overture's
 *     "theme=buildings/type=building/...", or "year=2024/month=06/...")
 * All are read by DuckDB with a recursive "**\/*.parquet" glob; Hive layouts add
 * "hive_partitioning=true" so the partition keys surface as columns.
 */

/**
 * A path/dir segment named like a Hive partition, e.g. "theme=buildings" or
 * "year=2024". Same rule the local browser uses to spot a partitioned dataset.
 */
export function isHivePartitionSegment(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*=.+$/.test(name);
}

export interface NormalizedRemoteParquet {
  /** The URL/glob to hand to DuckDB read_parquet(...). */
  readUrl: string;
  /** True when the read expands to many shards (a glob or a folder). */
  isFolder: boolean;
  /** True when any path segment is a "key=value" Hive partition. */
  isHivePartitioned: boolean;
}

const PARQUET_FILE = /\.parquet$/i;
const RECURSIVE_GLOB = "/**/*.parquet";

/**
 * Normalize a user-supplied cloud Parquet location into what DuckDB actually
 * needs, applying the same layout conventions as the local browser:
 *
 *   - explicit glob   ("dir/star.parquet", "dir/starstar/star.parquet") -> verbatim
 *   - single file     ("dir/data.parquet")                              -> verbatim
 *   - folder / prefix ("dir/theme=buildings/type=building")             -> recursive glob
 *
 * Hive partitioning is inferred from "key=value" segments anywhere in the path,
 * so it is detected whether the user points at the dataset root (partition keys
 * become columns) or deep inside one partition (the keys are constant columns).
 *
 * The caller MUST have validated the raw input with isSafeParquetUrl first;
 * this only appends a constant, injection-free glob suffix.
 */
export function normalizeRemoteParquetUrl(url: string): NormalizedRemoteParquet {
  const trimmed = url.trim();
  // Shape checks ignore any query string / fragment (presigned-URL tokens etc.).
  const path = trimmed.split(/[?#]/, 1)[0];
  const isHivePartitioned = path.split("/").filter(Boolean).some(isHivePartitionSegment);

  // Explicit glob — respect exactly what the user typed.
  if (path.includes("*")) {
    return { readUrl: trimmed, isFolder: true, isHivePartitioned };
  }
  // A single Parquet file — no partition columns to surface.
  if (PARQUET_FILE.test(path)) {
    return { readUrl: trimmed, isFolder: false, isHivePartitioned: false };
  }
  // A folder / prefix — recurse into every Parquet shard beneath it.
  const base = path.replace(/\/+$/, "");
  return { readUrl: `${base}${RECURSIVE_GLOB}`, isFolder: true, isHivePartitioned };
}

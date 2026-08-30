/**
 * Hive / multi-file remote sources on the WASM tier (build log D21).
 *
 * The old gate ("folder / hive-partitioned source (needs Docker)") was correct for
 * D13's mechanism — fetch ONE object, convert it to CSV — but that is no longer how
 * the tier reads remote data. Since D18/D19 DuckDB runs IN the worker and reads by
 * byte range, so "exactly one file" stopped being inherent to anything. This module
 * is what replaces the gate.
 *
 * FAN-OUT DECISION — one token PER FILE, not one prefix-scoped token.
 * A prefix token would let the worker supply part of the path, i.e. choose a
 * destination. That is exactly the property the D20 parity argument rests on ("the
 * worker picks offsets, never a destination"), and it is recorded there as a
 * standing invariant. N tokens keep it intact for the cost of N Map entries.
 *
 * ALIAS NAMING IS CORRECTNESS, NOT COSMETICS.
 * `hive_partitioning=true` derives partition columns FROM THE PATH
 * (`theme=buildings` → column `theme`). Registering files under synthetic names
 * would silently drop those columns — a query grouping on one would return
 * different results rather than fail. So each alias keeps the object key verbatim
 * and DuckDB parses partitions exactly as it would have from the real URL.
 */
import type { S3Object } from "@/lib/sandbox/s3-list";
import { aliasForKey } from "@/lib/sandbox/s3-list";

/**
 * Percent-encode an S3 key for a URL path WITHOUT encoding `=`.
 *
 * This is not a nicety: hive keys contain `theme=buildings`, and S3 treats
 * `theme%3Dbuildings` as a DIFFERENT key. Encoding it is precisely how the D18
 * spike first got HTTP 404 from a URL that curl fetched fine — duckdb-wasm was
 * escaping the `=`. `encodeURIComponent` leaves `-_.!~*\'()` alone but does encode
 * `=`, so we put it back; `/` stays a separator because we encode per segment.
 */
export function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%3D/gi, "="))
    .join("/");
}

export interface HiveAlias {
  /** The name DuckDB sees — the object key, so hive segments survive. */
  name: string;
  /** The same-origin token URL the worker range-reads. */
  url: string;
}

/**
 * Build the `read_parquet([...])` expression the generated code will use. The model
 * is already told to do `CREATE OR REPLACE VIEW data AS SELECT * FROM <readExpr>`
 * and then query `data`, so swapping this expression needs NO prompt change and no
 * change to the generated SQL.
 *
 * Single-quoted SQL literals: a `'` inside an S3 key is doubled, so a key can never
 * terminate the literal. (Keys may contain quotes; this is fed from a remote listing.)
 */
export function buildHiveReadExpr(aliases: readonly HiveAlias[], hivePartitioned: boolean): string {
  if (aliases.length === 0) throw new Error("buildHiveReadExpr: no files to read");
  const list = aliases.map((a) => `'${a.name.replace(/'/g, "''")}'`).join(", ");
  return `read_parquet([${list}]${hivePartitioned ? ", hive_partitioning=true" : ""})`;
}

/**
 * Map enumerated objects → aliases, minting one range token per file via the
 * supplied registrar. The registrar is injected (rather than importing the
 * singleton) so this stays pure and testable.
 */
export function buildHiveAliases(
  objects: readonly S3Object[],
  host: string,
  registerToken: (url: string, sizeBytes: number) => string
): HiveAlias[] {
  return objects.map((o) => {
    // The upstream URL is resolved HERE, host-side; the worker never sees it.
    const upstream = `https://${host}/${encodeS3Key(o.key)}`;
    const token = registerToken(upstream, o.size);
    return { name: aliasForKey(o.key), url: `/api/wasm-range/${token}` };
  });
}

/**
 * The per-file byte budget. A token must be allowed to serve the file's footers and
 * whichever row groups match the predicate — but not to become an unbounded pull of
 * the whole object across many requests. Two footers plus a generous slice of the
 * file, floored so tiny files are still readable.
 */
export function budgetForFile(sizeBytes: number): number {
  const HALF = Math.ceil(sizeBytes / 2);
  const FLOOR = 8 * 1024 * 1024;
  return Math.max(FLOOR, HALF);
}

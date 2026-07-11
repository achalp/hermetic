# Schema cache — source-agnostic, fingerprint-gated

_Created: 2026-07-11_

## Problem

Connecting a source runs an EXPENSIVE "understand it deeply" step every time:
remote Parquet schema extraction is ~27 s (profiling over the network),
warehouse introspection is ~1–2 min (every column + PK/FK for every table).
Nothing was cached across calls, so the same unchanged source paid the full
cost on every reconnect, TTL expiry, or server restart.

## Principle (the design constraint)

Hermetic is **source-agnostic**: it must detect what it's dealing with from
universal signals, never hardcode a dataset's conventions. So freshness is
**not** inferred from a URL naming pattern (e.g. "an Overture release path is
immutable"). Instead:

> Cache the expensive artifact keyed by source identity. Gate reuse on a
> **fingerprint** computed from the cheapest metadata the storage layer itself
> exposes — a file listing, a table listing, an object version. Detect change
> by fingerprint mismatch.

The elegant consequence: **immutability is detected, not assumed.** An immutable
source yields a stable fingerprint and gets free caching as an emergent
property; a mutable one changes its fingerprint and re-extracts. No source is
special-cased — Overture "just works" without the code knowing it's Overture.

Every source has a cheap "what is this / has it changed" probe and an expensive
"understand it deeply" step; the cache pairs them.

## Core (`src/lib/schema-cache.ts`)

Generic, disk-backed (`data/schema-cache/<sha256(sourceKey)>.json`), best-effort
(any cache failure degrades to a normal extraction, never an error).

`resolveWithCache({ sourceKey, fingerprint, extract, force })`:

- `force` (the "ignore cache / re-read" control) → skip the lookup, extract
  fresh, overwrite the cache so subsequent calls hit. Status `forced`.
- else compute the cheap fingerprint; if it matches the cached entry → return
  cached (`hit`); if it differs → re-extract (`stale`); if no entry → extract
  (`miss`).
- The fingerprint probe is best-effort: if it throws (a transient metadata
  error) we do NOT serve a maybe-stale cache — we re-extract. Correctness over
  speed on the error path.

The stored fingerprint must reflect whatever the cached artifact depends on
(see per-source below) — not incidental metadata.

## Per-source fingerprints (universal signals only)

### Remote Parquet — file-listing digest

`computeRemoteParquetFingerprint` runs a tiny DuckDB `glob()` in the sandbox and
digests the **sorted file listing** (`buildParquetFingerprintScript`). Reads
only the object-store LISTING, never file data or footers — sub-second vs the
~27 s extraction. Source-agnostic and catches the dominant change modes:

- files added / removed → listing changes;
- data rewritten → Spark/Delta/Iceberg/Hive writers emit **new filenames** (the
  `part-00000-<uuid>` GUID is a content/commit id), so the listing changes
  without reading a byte.

The cached Parquet schema includes **data profiling** (min/max/distinct), so its
freshness depends on the data — which the file listing tracks. **Blind spot:** a
same-filename in-place byte overwrite (rare for lakes); the manual refresh /
ignore-cache controls cover it. A `ListObjects`-with-`{size,etag,mtime}` digest
(per-provider SDK) is the documented follow-on for exactness.

### Warehouse — table-listing fingerprint

`warehouseTablesFingerprint` hashes the already-fetched `listTables()` output
(`schema.table:columnCount`, sorted). `listTables()` is already called on every
connect and is far cheaper than `introspectAllTables()`; Postgres et al. return
`column_count` from the catalog for free — **zero per-engine code**. The
fingerprint is STRUCTURAL: it changes when a table or column is added/dropped
but **not** on ordinary data writes (row-count estimates are deliberately
excluded — they'd churn the cache while telling us nothing about the structural
schema the artifact captures). **Blind spot:** a column rename / retype at the
same count; the manual refresh covers it.

`warehouseSourceKey` keys on identity (type + host + db/dataset/catalog + schema

- user) and **omits secrets** — a password change must not create a new cache
  entry, and secrets must not sit in a cache key.

## Controls (user-facing)

1. **Ignore-cache checkbox** in both connect surfaces — the remote-Parquet URL
   panel (`local-file-browser`) and the warehouse form
   (`inline-connection-form`). Threads `force` → `extractRemoteParquetSchema` /
   `connectWarehouse` → the route → `resolveWithCache({ force })`. For warehouse
   the flag rides in the request body; the config's discriminated-union schema
   strips it, and the route reads it from the raw body before parsing.
2. **Refresh-schema button (↻)** in the data-rail schema sidebar — re-reads the
   current source with `force`. `use-warehouse` retains the last config
   (`refresh()`); `use-source-select` retains the last remote URL+creds
   (`refreshRemote()`, gated on `hasRemoteSource` so an uploaded CSV — which has
   no source to re-read — shows no button).

## Tests

- `schema-cache.test.ts` — hit / miss / stale / forced, force-overwrites-then-
  hits, probe-failure-re-extracts, corrupt-entry tolerance, delete (12 cases,
  fs mocked).
- `warehouse/schema-fingerprint.test.ts` — source key omits secrets & is
  db/schema-scoped; fingerprint is order-independent, changes on column/table
  add-drop, and is stable across row-count drift (6 cases).
- `remote-parquet/schema/route.test.ts` — force passthrough + default, cache
  status, schema re-stamp.
- `warehouse/connect/route.test.ts` — introspects through the cache; `force`
  from the body reaches the resolver without breaking union parsing.

## Follow-ons

- Per-provider `ListObjects` `{etag,size,mtime}` digest for exact in-place-
  overwrite detection on mutable buckets.
- Per-engine table-altered timestamp short-circuit (Snowflake `LAST_ALTERED`,
  BigQuery `lastModifiedTime`) for a fingerprint that also catches same-count
  column renames.
- Optional cache TTL / size cap (today entries live until the source's
  fingerprint changes or a manual refresh; the cache is small — one entry per
  source).

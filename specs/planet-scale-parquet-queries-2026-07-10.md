# Planet-scale queries over remote Parquet (the sandbox/DuckDB path)

_Created: 2026-07-10_

## The problem

Questions like **"which building in the world is farthest from its nearest
neighbor"** are unbounded global superlatives over the entire Overture buildings
dataset — **2.54 billion rows** across 512 Parquet files on S3. Every approach
that reads all 2.5B rows at full resolution pays a multi-GB / multi-hour S3
scan and blows the 20-minute sandbox budget (measured: California's 13.7M
buildings alone take ~3 min; the planet is ~185× that). There is no named
region to prune on. See `fixes.md` (2026-07-09 "which building in the WORLD"
run `a6ae0b22`, which timed out at the full 20-min budget).

We need a technique that answers a global spatial superlative **without reading
every building**.

## Key insight

For a **superlative that selects a sparse-region outlier** (most-isolated /
loneliest / farthest-from-neighbor), the answer lives in an extremely
low-density area by definition: if building B\* has nearest-neighbor distance
D\* (tens of km for the global winner), then a disc of radius D\* around B\*
contains no other building — so B\*'s local density is ≤ 1 building per ~πD\*².
Its nearest neighbor N\* is equally remote. **Both the winner and its neighbor
sit in the sparsest regions of the planet.** So we never need the dense 99% of
buildings — we only need to find the sparse regions and scan those.

## The technique: metadata-first coarse-to-fine

Three phases. The first reads only Parquet **footers** (KB, not GB); the second
reads only the sparse tail (single-digit % of the planet); the third verifies.

### Phase 1 — Global density map from row-group metadata (~24 s, no data scan)

`parquet_metadata()` exposes, per row group, the min/max of each `bbox`
sub-column and the row count — all from the file footers, no data read.
Measured over the full global glob: **512 files, 72,448 row groups, returned in
~24 s.**

```sql
WITH m AS (
  SELECT file_name, row_group_id, path_in_schema AS col,
         CAST(stats_min AS DOUBLE) AS lo, CAST(stats_max AS DOUBLE) AS hi,
         row_group_num_rows AS n
  FROM parquet_metadata('s3://overturemaps-us-west-2/release/2026-05-20.0/theme=buildings/type=building/*.parquet')
  WHERE path_in_schema IN ('bbox, xmin','bbox, xmax','bbox, ymin','bbox, ymax')
),
rg AS (   -- one row per row group: its spatial extent + building count
  SELECT file_name, row_group_id, any_value(n) AS rows,
         min(CASE WHEN col='bbox, xmin' THEN lo END) AS xmin,
         max(CASE WHEN col='bbox, xmax' THEN hi END) AS xmax,
         min(CASE WHEN col='bbox, ymin' THEN lo END) AS ymin,
         max(CASE WHEN col='bbox, ymax' THEN hi END) AS ymax
  FROM m GROUP BY file_name, row_group_id
)
SELECT *, rows / greatest((xmax-xmin)*(ymax-ymin), 1e-9) AS density_per_deg2 FROM rg;
```

Overture sorts buildings spatially (a space-filling curve), so row groups are
**spatially tight** — measured median extent ~0.24° × 0.13° (~26 km × 14 km).
Dense cities land in tight, high-count row groups; remote/scattered buildings
get lumped into a few **wide-spanning** row groups. Both signals identify the
sparse tail.

### Phase 2 — Fine scan of the sparse tail only (minutes, not hours)

Select the candidate row groups — **low density OR wide span** — and read only
their buildings' `bbox` centroids. Measured tail size on release 2026-05-20.0:

| candidate rule               | row groups | buildings | share of planet |
| ---------------------------- | ---------- | --------- | --------------- |
| `density < 1000 /deg²`       | 97         | 3.26 M    | 0.13 %          |
| `span_x > 5° OR span_y > 5°` | 1,253      | 45.5 M    | 1.8 %           |

Union of the candidate row-group **extents** becomes a bbox filter on the
buildings read; DuckDB's own row-group stats then skip everything else. Reading
~3–45 M rows' `bbox` (two floats) is single-digit-% of a full scan — a couple of
minutes — and fits a KD-tree in the ~2 GB sandbox (45 M × 2 × 8 B ≈ 0.7 GB).
Project to meters, build `scipy.spatial.cKDTree`, take each point's
nearest-neighbor distance, keep the top-K most isolated.

### Phase 3 — Verify the top-K exactly (seconds)

Within-candidate NN is an **upper bound** on each candidate's true NN distance
(a candidate's real nearest neighbor could be a denser non-candidate building
just outside the tail). For the global winner this cannot happen — its NN is
remote and therefore in the tail — but a near-city sparse point could look
falsely isolated. So for each of the top-K candidates, read every building
within its claimed NN radius via a tiny bbox query and recompute the exact NN.
Drop any whose verified distance collapses; the survivor with the max verified
distance is the answer. This makes the result **exact for the winner**, not just
an approximation.

### Disclosure

Set `results["analysis_scope"]`: the density/span threshold used, the candidate
building count actually scanned, and that the dense majority was excluded by the
sparsity argument (it cannot contain a most-isolated outlier). Honest and
reproducible — the reader sees exactly what was computed.

## Why this is correct (not just fast)

The sparsity argument is a proof for the extreme: the global max-NN building and
its neighbor are both forced into the low-density tail, so a conservative
threshold that admits the tail cannot exclude them. Phase 3 removes the only
false-positive mode (near-dense candidates whose true NN is just outside the
tail). Widen the threshold if Phase 3 drops too many, or if the top-K verified
distances cluster near the threshold boundary (a sign the tail was cut too
tight).

## Limits / when it does NOT apply

- **Only for sparse-selecting superlatives** (most-isolated, farthest-neighbor,
  emptiest-region). A global superlative that selects a DENSE outlier (e.g.
  "densest cluster of buildings") is the opposite tail — same metadata map, pick
  the high-density row groups instead — still cheap. But an aggregate needing
  EVERY row (global average building height, total count) genuinely must scan
  everything and is not a fit; answer those with a bounded/disclosed scope or a
  warehouse that scales the scan server-side.
- Relies on the source having a per-row-group-statable `bbox` (Overture does)
  and a spatial sort (Overture does). A non-spatially-sorted dataset would have
  wide, useless row-group extents — detectable from Phase 1 (median span near
  global) and a signal to fall back to disclosed scoping.
- The thresholds (density cutoff, K) are heuristics; Phase 3 + the widen rule
  keep them honest.

## The general pattern (any granularity, geo AND non-geo)

The loneliest-building technique is one instance of a broader principle that
applies at **any** granularity (Seattle, California, the planet) and to **any**
column, spatial or not. The right question for any "compute X over a big
dataset" request is: **how much of the data does the answer actually depend
on?** Three classes:

- **(A) Extreme / selective** — the answer is a FEW rows with an extreme
  property (tallest, largest, oldest, rarest, most-isolated, top-N). You never
  need every row: eliminate the majority that provably can't win with cheap
  per-row-group stats, then scan only the survivors.
  - _Stored column_ (height, amount, timestamp): Parquet **zone maps** —
    `parquet_metadata` gives per-row-group `stats_min`/`stats_max`; for a MAX
    query skip every row group whose `stats_max < best-so-far`. Exact, near-free,
    universal (any orderable column). This is branch-and-bound / zone-map
    pruning.
  - _Derived property_ (spatial isolation, largest gap between consecutive
    events): a cheap proxy from the same metadata — spatial isolation → density
    from bbox extent + count (the recipe above).
- **(B) Metadata-only aggregate** — `COUNT(*)`, `MIN`, `MAX`, value range/extent:
  read straight from the footers (`COUNT(*)` = `SUM(row_group_num_rows)`;
  `MIN/MAX` = min/max of the stats). No data scan at all.
- **(C) Holistic aggregate** — `AVG`, `MEDIAN`, `SUM`, `COUNT(DISTINCT)`, a full
  distribution or per-group rollup: every row contributes, footer stats can't
  give these, so scan them all — or, if that exceeds budget, a bounded/disclosed
  scope or a uniform sample (never a partial passed off as the whole).

The through-line across all of it — and across the app's existing two-phase
geometry read and numeric-first-then-hydrate pass — is **read the cheap thing to
eliminate, read the expensive thing only for what survives**; metadata is just
the cheapest possible "eliminate" step.

**Granularity crossover:** the principle holds at every scale, but the machinery
only earns its keep once the full numeric scan of the region no longer fits the
budget comfortably. Seattle (~1M) — just scan. California (13.7M, ~3–4 min) —
metadata-first is an optional ~30 s speedup. The planet (2.5B) — necessary.
Below the crossover, scan directly; above it, prune-first.

## Implementation

- **General classify-first guidance** — `scanStrategyNote()` in
  `src/lib/parquet/duckdb-source.ts`, injected into the Data-Location context for
  any large Parquet source (`rowCount > LARGE_ROWS`, geo or non-geo), alongside
  the existing `remoteNetworkNote`. Teaches the model to pick class A/B/C and the
  matching approach, with the `parquet_metadata` path interpolated from the read
  expression.
- **Spatial recipe** — the density/sparse-tail/verify detail stays in the
  geospatial section of `src/lib/llm/prompts.ts` (gated on `bbox` presence),
  framed as the spatial case of class A and pointing back to the scan-strategy
  note.

Validated empirically against release 2026-05-20.0 (numbers above) with the
DuckDB CLI.

## Follow-ups

- Validate a full end-to-end run in the sandbox (all three phases) and record
  the actual winner + wall time.
- The same metadata map answers "which REGION has the fewest/most buildings"
  and coarse global choropleths without a full scan — worth generalizing.

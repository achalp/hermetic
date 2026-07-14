# Planet-scale spatial analysis — a generic coarse-to-fine method (2026-07-13)

Design for answering spatial questions over datasets too large to pull into RAM. NOT a plugin
system Hermetic executes — Hermetic generates bespoke Python per question. This is a **mental
model that shapes the code-gen GUIDANCE** (in `prompts.ts`), so the LLM writes correct, general
code for whatever planet-scale question arrives. The loneliest-building (max-NN) case and the
Overture dataset are just the first worked examples, NOT the design's scope.

## Three orthogonal layers

1. **Engine (query- and source-agnostic):** metadata-first, coarse-to-fine over a hierarchical
   partition; each cell carries a MERGEABLE summary; a query-supplied RULE prunes / rolls up /
   refines; raw rows are touched ONLY for survivors. (A spatial OLAP cube with pushdown.)
2. **Spatial specialization:** a **quadtree** in a meter projection, keyed `floor(x/s),floor(y/s)`.
   Chosen over S2/H3/geohash because a quadtree cell IS an axis-aligned bbox range → it maps to
   `WHERE <coord> BETWEEN …`, which is what columnar **zone-maps prune on**. That pushdown is the
   entire economics; S2/H3 cells aren't rectangles, so they'd lose it. (S2/H3 win on equal-area/
   isotropy; quadtree's lat distortion is bounded — populated land is within ±60°, ≤2× aspect —
   and correctable via `cos(lat)`.)
3. **Plug-ins (LLM decisions, shaped by guidance — NOT loaded modules):** the query's
   (summary, rule) and the source adapter.

## Step 0 — CLASSIFY, then route (the load-bearing decision)

Before anything, estimate in-scope N from metadata and classify the query + source:

- **Fits RAM** (≲ 35M points; `N·56 B` < ~2 GB incl. cKDTree query arrays) → **DIRECT**: pull
  numeric coords, one exact pass. Skip ALL grid machinery. (Seattle, CA, Ask-mode.)
- **Doesn't fit** (USA ~130M, planet 2.5B) → **COARSE-TO-FINE** (below).
  Getting this right is what prevents over-engineering small N and prevents OOM on large N. The
  past USA OOM was mis-routing 130M onto the DIRECT path via a leaky prune.

## Seam 1 — the query supplies a (summary, rule). NOT NN-specific.

| Query class                                                      | Per-cell summary                  | Rule                             |
| ---------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| Extremal on a STORED column (tallest, oldest)                    | `max/min(col)` (a zone-map)       | prune cells whose `max < best`   |
| Extremal on a DERIVED spatial prop (loneliest, most-clustered)   | count (+ neighbor occupancy)      | geometric bound (see NN example) |
| Selective / spatial join ("within 100m of a river")              | can-any-row-match flag            | drop provably-empty cells        |
| Decomposable aggregate (COUNT, SUM, MIN/MAX, extent, choropleth) | partial aggregate / count         | roll up — no drill               |
| Holistic aggregate (MEDIAN, DISTINCT, percentiles)               | a mergeable SKETCH (t-digest/HLL) | merge → approximate, or scan     |

## Seam 2 — the source adapter. NOT Overture-specific.

Engine needs four hooks; Overture is one binding:

1. `point(row) → (lon,lat)` — Overture: bbox center. GeoParquet: geometry/centroid. Plain
   table: `lat`,`lon` cols. Warehouse: `ST_X/ST_Y`.
2. `coord_zonemaps()` — per-partition coord min/max for the free coarse level. Overture:
   `parquet_metadata` bbox sub-cols. Generic Parquet: `parquet_metadata` min/max on lat/lon
   cols. GeoParquet: the `bbox` covering column. Warehouse: server-side `GROUP BY` grid.
3. `range_filter(lon_range, lat_range)` — the pruning WHERE. Overture: `bbox.* BETWEEN`.
   Generic: `lat/lon BETWEEN`.
4. _(optional)_ `region_boundary(name)`, `hydrate(cols)` — Overture: divisions, `names.primary`;
   generic: a user polygon or none.
   Nothing in the engine references bbox structs, division_area, names.primary, or an S3 path.

## Honest data dependency + graceful degradation

Pruning power rests on TWO source properties, not on Overture:

- coordinate **zone-maps exist** per partition, AND
- data is **spatially clustered** so those zone-maps are tight.
  If missing: no zone-maps (CSV/unsorted) → pay ONE bounded `GROUP BY` scan to build the coarse
  grid, then drill (correct, one scan more). Not spatially sorted (zone-maps span the globe) →
  repartition/sort by a spatial key once, or fall back to a single scan. So the method **never
  breaks — it degrades to one bounded scan** when the free-metadata shortcut isn't available. The
  engine should CLASSIFY the source's index quality first, same as it classifies the query.

## COARSE-TO-FINE engine (when N doesn't fit)

1. **Cell summaries, coarsest level.** Bounded region → one `GROUP BY` of the summary by
   `floor(x/s),floor(y/s)` (streams, memory-tiny). Planet → seed from `parquet_metadata`
   (free), then `GROUP BY` finer ONLY inside surviving coarse cells, recursively.
2. **Prune / roll up** by the query rule.
3. **Refine** surviving cells (halve `s`, recount only within) — this ADAPTS `s` to the unknown
   local scale (a single fixed `s` fails; a quadtree is the point). Dense cells stop refining
   once they prune; sparse/ambiguous cells refine until small enough to read.
4. **Leaf (POINT-ANCHORED, not region-materialization):** the exact step is a per-candidate
   nearest-neighbor QUERY, not "read the ring." Reading the full `ceil(UB/s)` ring OOMs — an
   isolated `q`'s nearest occupied neighbor can BE a dense metro edge, so its ring overlaps
   millions (OBSERVED: the leaf OOM'd the USA run at ~28 min _after_ the counts succeeded).
   Instead, per candidate `q`: read `q`'s own (sparse) cell; use the CELL COUNTS already
   computed (no data read) to find the nearest OTHER occupied cell by increasing Chebyshev
   radius; read ONLY that cell — and if it is DENSE, sub-grid THAT ONE cell and read only the
   sub-cell on `q`'s facing side (you need the nearest POINT, not the metro). NN = min distance
   from the single point `q` to the points read = **O(cell), linear — never an all-pairs cKDTree
   over the ring** (that materialization/`O(n²)` is the trap). Skip any survivor with `UB < B`
   unread. Only `q`'s cell + one nearest (sub-)cell per survivor reach pandas → never OOMs.
   This is the whole method recursing: coarse-to-fine + count-pruning, now anchored at a point.
   Blindly adding a finer grid or pushing the ring into DuckDB just SHIFTS the read (DuckDB still
   scans the metro); the optimization is using counts to avoid issuing a query that overlaps the
   dense mass at all.

## WORKED EXAMPLE A — derived-spatial extremal (loneliest building)

Rule uses count-based bounds. Cell C side `s`, `occ`=count, `k`=Chebyshev cells to nearest other
occupied cell. `B`=best CONFIRMED NN so far.

- `occ≥2` → `UB = s·√2`; `occ=1` → `UB = (k+1)·s·√2`, `LB = (k−1)·s`.
- Prune C iff `UB(C) < B` (true upper bound → winner never pruned). Exact NN needs a ring of
  radius ≥ `UB/s` (NN crosses cell edges). Ring read against ALL rows (unfiltered by region)
  also FIXES the nearest-neighbor-across-border overstatement of a polygon-only KD-tree.
- **s selection:** floor = ≫ typical spacing (so dense cells collapse to few cells); ceiling =
  < the answer (so the winner stays a singleton). Err FINE. Don't pick one `s` at all when the
  scale is unknown — refine the quadtree.

## Routing examples (shows degradation, from the Seattle test)

| Scope                  | N                      | Fits?             | What the framework emits                                                  |
| ---------------------- | ---------------------- | ----------------- | ------------------------------------------------------------------------- |
| Seattle (loneliest)    | 299,976 (~7 MB coords) | yes (100× margin) | DIRECT: polygon + full KD-tree. **Grid dormant.** = current working code. |
| Seattle (tallest)      | 299,976                | yes               | zone-map / `max(height)`. No KD-tree, no grid.                            |
| Seattle (density)      | 299,976                | yes               | `GROUP BY cell, COUNT` — counts ARE the answer.                           |
| California (loneliest) | 13.7M (~330 MB)        | yes               | DIRECT: polygon + KD-tree (~7 min). Grid optional speedup only.           |
| USA (loneliest)        | ~130M                  | **no**            | COARSE-TO-FINE quadtree → sparse survivors → exact.                       |
| Planet (loneliest)     | 2.5B                   | **no**            | metadata L0 → drill sparse frontier → exact.                              |

Validated: small N collapses to the simple exact method (no over-engineering); the grid wakes
only at the tail.

## Guidance vs crystallized code

Default = **prompt guidance** framed by this model (classify query + source → pick summary/rule/
adapter → direct or coarse-to-fine). Crystallize into a preloaded helper ONLY the narrow,
query-AGNOSTIC primitive that keeps failing under guidance — candidate: a memory-safe
`grid_counts(source, s)` / `coarse_to_fine(summary, rule)` mechanic the LLM feeds a summary+rule
into (stays generic; removes the OOM footgun). Build it only if run-recorder evidence shows
guidance alone keeps OOMing — NOT speculatively, and NEVER an NN- or Overture-specific plugin.

## Open questions for tomorrow

- Planet L0: is `parquet_metadata` (row-group ~26×14 km) fine enough to seed, or is one global
  bbox `GROUP BY` at 2.5B affordable? Needs a measured read estimate.
- `k`-search + refinement stopping rule at fine resolution.
- Where the source-adapter classification lives (guidance heuristic vs a small detector).

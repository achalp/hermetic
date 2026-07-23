// GENERATED-ONCE from the buildGeospatialGuidance monolith in llm/prompts.ts
// (split 2026-07-22, see spec/skills-implementation-plan-2026-07-22.md).
// The equivalence snapshot test locks the concatenated output byte-for-byte —
// edit the text here freely going forward, but update the snapshots knowingly.
// Section 2: KD-tree routing, canonical skeleton, ENGINE-FIRST, PLANET-SCALE counting recipe.
import type { SkillDefinition, SkillRenderContext } from "../types";
import { hasBareGeometryColumn } from "../triggers";

/**
 * The branch-and-bound math as EXECUTABLE functions (guards in code, not
 * prose): the occ-aware upper bound is the #1 correctness bug when the model
 * re-derives it (a remote cluster beats a lone building), and the scalar-NN
 * SQL is the #1 OOM when hand-rolled as a ring read. Pure math + SQL string
 * builder — no duckdb import, so it is unit-testable anywhere and the
 * generated code keeps explicit control of query execution.
 */
const PLANET_SCALE_HELPER = `"""Branch-and-bound helpers for most/least-isolated superlatives.

Pure functions: math + SQL string builders. Execute the SQL yourself with
duckdb.sql(...) so scans stay visible in your code.
"""

import math


def occ_aware_ub(occ, k, s):
    """Upper bound (meters) on a cell's best isolation - occ-AWARE, the critical bit.

    A cell with occ >= 2 holds two buildings within one diagonal (ub = s*sqrt(2));
    only an occ == 1 cell can use the (k+1)-ring bound. Ranking every cell by the
    ring bound alone picks a remote CLUSTER over a lone building (observed bug).
    k is the Chebyshev grid-distance to the nearest OTHER occupied cell.
    """
    return s * math.sqrt(2.0) if occ > 1 else (k + 1) * s * math.sqrt(2.0)


def chebyshev_k(cx, cy, occupied):
    """Chebyshev grid-distance from cell (cx, cy) to the nearest OTHER occupied cell.

    occupied is an iterable of (cx, cy) tuples (or a set). Pure python over the
    SMALL cells table - never call this per raw building.
    """
    best = None
    for ox, oy in occupied:
        if ox == cx and oy == cy:
            continue
        d = max(abs(ox - cx), abs(oy - cy))
        if best is None or d < best:
            best = d
            if best == 1:
                break
    return best


def scalar_nn_sql(qlon, qlat, half_deg, source="data", exclude_eps=1e-7):
    """The bounded scalar-aggregate nearest-neighbour SQL for candidate (qlon, qlat).

    Returns ONE row / ONE float (meters): min ST_Distance_Sphere over a bbox
    window of +/- half_deg degrees, excluding the candidate itself. Execute with
    duckdb.sql(scalar_nn_sql(...)).fetchone()[0] - NEVER read the ring into
    pandas and NEVER build a KD-tree over it (that is the recurring OOM).
    """
    return (
        "SELECT min(ST_Distance_Sphere(ST_Point({qlon}, {qlat}), "
        "ST_Point((bbox.xmin+bbox.xmax)/2.0, (bbox.ymin+bbox.ymax)/2.0))) "
        "FROM {source} "
        "WHERE bbox.xmin BETWEEN {lon_lo} AND {lon_hi} "
        "AND bbox.ymin BETWEEN {lat_lo} AND {lat_hi} "
        "AND NOT (abs((bbox.xmin+bbox.xmax)/2.0 - {qlon}) < {eps} "
        "AND abs((bbox.ymin+bbox.ymax)/2.0 - {qlat}) < {eps})"
    ).format(
        qlon=float(qlon),
        qlat=float(qlat),
        source=source,
        lon_lo=float(qlon) - float(half_deg),
        lon_hi=float(qlon) + float(half_deg),
        lat_lo=float(qlat) - float(half_deg),
        lat_hi=float(qlat) + float(half_deg),
        eps=float(exclude_eps),
    )
`;

export const planetScaleSuperlative: SkillDefinition = {
  name: "planet-scale-superlative",
  description:
    "Count-don't-materialize recipe for nearest/farthest superlatives: size routing, assert_fits gates, branch-and-bound cells, scalar-aggregate leaves",
  order: 20,
  origin: "builtin",
  reviewGate: true,
  requires: ["geo-overture"],
  triggers: {
    when: hasBareGeometryColumn,
    label: "geometry column present (no GeoJSON sidecar)",
  },
  helpers: [{ moduleName: "planet_scale", content: PLANET_SCALE_HELPER }],
  // Superlative/scale critic rules — moved here from code-review.ts.
  reviewRules: [
    `MEM-KDTREE — a scipy/sklearn spatial index (cKDTree, KDTree, BallTree) is built over the RAW points/buildings of a large scan. A KD-tree over millions of points allocates several N-sized arrays and OOMs. (A KD-tree over a small aggregated CELLS table — tens of thousands of rows — is FINE, do not flag that.)`,
    `MEM-RING — a nearest-neighbour / "leaf" / farthest / most-isolated step reads a whole RING or radius of buildings into pandas, or accumulates rings across candidates. The neighbour distance must be a DuckDB aggregate (min(ST_Distance...) over a bounded bbox window) returning ONE scalar per candidate.`,
    `GRID-SCALE — a grid/cell superlative uses a FIXED small cell size (e.g. 10 km) regardless of region span. Over a continent that emits far too many cells. Cell size must scale to the span (e.g. s = max(span_m/200, floor)).`,
    `HARDCODE-EXTENT — magic coordinates/extents that should be DERIVED from the data (the divisions Phase-A extent) are hardcoded, so a clamp silently excludes the target (e.g. a country boundary row whose bbox spans the antimeridian).`,
    `SCAN-OR — a REMOTE parquet scan's WHERE combines multiple bbox windows with OR (e.g. hydrating several winners' boxes in one query). An OR of multi-column conjunctions cannot be pushed into parquet zonemap/row-group pruning, so the "tiny" read silently full-scans the whole theme (observed: a 5-box OR turned a winner hydration into a 10+ hour multi-scan). Issue one AND-only query per window (a loop or UNION ALL) — and never precede a remote read with a COUNT(*) of the same predicate against the remote source (that is a second full scan; count the fetched frame with len(df) instead).`,
  ].join("\n"),
  failureHints: [
    {
      pattern: "leaf|neighbou?r|nearest|hydrat|candidate|winner",
      hint:
        "The OOM struck during the PER-CANDIDATE LEAF / nearest-neighbour read. Do NOT read a whole ring of buildings " +
        "into pandas and do NOT accumulate rings across candidates — an isolated point's nearest neighbour can be a " +
        "dense metro edge, so its ring overlaps millions of rows. Compute the neighbour distance INSIDE DuckDB as a " +
        "bounded aggregate (SELECT min(ST_Distance_Sphere(...)) over a small bbox window), pulling only ONE scalar per " +
        "candidate — the preloaded skill_lib.planet_scale.scalar_nn_sql() builds exactly this query. Never build a " +
        "cKDTree over the buildings in a ring.",
    },
    {
      pattern: "cell|grid|coarse|group|bucket|count|superlativ",
      hint:
        "The OOM struck during the COARSE GRID COUNT/SCAN. TWO independent causes: (A) DuckDB's own PARALLEL SCAN " +
        "buffers over a billions-row REMOTE parquet scan — memory_limit does NOT bound the per-thread row-group " +
        "read/decompress buffers, so a default all-cores scan blows the cap even though the GROUP BY output is tiny. " +
        "The sandbox already SETs a low `threads` + `preserve_insertion_order=false` for this — do NOT raise `SET " +
        "threads`, and if you did, remove it. (B) The cell size may be too FINE for the region span (a fixed 10 km " +
        "cell over a ~5,000 km continent makes ~25x more cells): scale it — s = max(span_m/200, 2000). Keep the GROUP " +
        "BY streaming (never pull raw buildings into pandas); if the cells frame is still millions of rows, coarsen s.",
    },
    {
      // Catch-all (matches ANY phase, including none): a bare 137 on a run
      // where THIS skill is active is almost certainly the remote-parquet
      // scan-buffer sink. Must stay LAST so the specific hints above win, and
      // fallback-only so a watchdog-predicted abort keeps its own message.
      pattern: "^",
      fallback: true,
      hint:
        "Out of memory — a HARD kernel OOM-kill (exit 137) with NO pandas-side guard tripped (the .df() cap raises a " +
        "clean error, not 137; the memory watchdog would have tagged a phase). That signature means the memory sink is " +
        "NOT your pandas code — it is almost certainly DuckDB's PARALLEL SCAN BUFFERS over the billions-row remote " +
        "parquet: memory_limit does NOT bound the per-thread row-group read/decompress buffers, so the scan itself blows " +
        "the cap even when your GROUP BY output and KD-tree are tiny. So do NOT (again) trim columns, re-verify " +
        "coordinates-only, or restructure the candidate/branch-and-bound logic — that side is already fine. Instead: " +
        "(1) COARSEN the grid so fewer/larger cells stream through — s = max(span_m/300, 2000) rather than a fine fixed " +
        "cell; (2) keep every heavy step in DuckDB (COUNT/GROUP BY streams and spills) and pull only the tiny survivor " +
        "set into pandas; (3) do NOT add `SET threads=<high>` — the sandbox already caps scan threads low for exactly " +
        "this reason. If you genuinely just built a huge N-sized PYTHON object (a dict/list over ALL rows, e.g. to label " +
        "a map sample) that is the one pandas-side way to hard-kill — index by position instead, never build an N-sized map.",
    },
  ],
  // Wire the shared memory guards to this skill's strategy: assert_fits /
  // watchdog failures now point at the DOESN'T-FIT recipe ONLY when this
  // skill is active (the base guard message is domain-neutral).
  preludeSnippet: `
# planet-scale-superlative skill prelude (auto-injected)
try:
    import hermetic_runtime.guards as _psg
    _psg.set_strategy_hint(
        " At THIS scale even coordinates-only does NOT fit (cKDTree.query also allocates two"
        " more N-sized arrays) - follow the PLANET-SCALE / DOESN'T-FIT recipe: bucket rows"
        " into grid cells with GROUP BY, branch-and-bound on the small cells table, and pull"
        " ONLY the tiny survivor set; do not materialize the tail."
    )
    _INFEASIBLE_MSG = _psg.INFEASIBLE_MSG + _psg.get_strategy_hint()
except Exception:
    pass
`,
  buildGuidance({ sandboxMemoryGb }: SkillRenderContext): string {
    return `CRITICAL — nearest/farthest-neighbor: a SQL distance self-join is O(n^2) and WILL time out, so do NOT self-join the full table. Instead build a KD-tree in Python (scipy.spatial.cKDTree, O(n log n)) over ALL points in scope (every building in the bounding box) — do not downsample; a KD-tree handles the full region and downsampling would miss the true extreme.
ROUTE BY SIZE FIRST — estimate N in scope from parquet_metadata (SUM(row_group_num_rows) over row groups whose bbox overlaps the region). If N FITS RAM (≲ ~30M points — BOTH the rowid+lon+lat coords frame AND the cKDTree.query(k=2) output arrays must fit under the cap) use the DIRECT KD-tree (skeleton next — this is Seattle ~0.3M, California ~13.7M). If N does NOT fit (whole USA ~130M, planet 2.5B) you CANNOT pull coords into pandas at all — a coords .df() over ~100M+ rows is THE OOM even "coords-only" — jump to PLANET-SCALE / DOESN'T-FIT below, which COUNTS in DuckDB and materializes only the tiny survivor set.
GATE THE DECISION IN CODE, DON'T EYEBALL IT — after a cheap COUNT(*) of the in-scope rows, call the preloaded \`assert_fits(N, cols=3)\` BEFORE the coords .df(). It raises (with the exact "switch to DOESN'T-FIT" instruction) when N cannot fit the container's REAL memory cap — so the direct path is taken only when it provably fits, and an over-scale region is forced onto the counting strategy on the FIRST attempt, not after a 25-minute OOM. If it raises, do NOT catch it and retry the direct approach with fewer columns — that is the DIVERGENCE TRAP (each retry trims a column, scans MORE, and OOMs later: observed 6→15→29 min across three attempts). Fewer columns does not help once N is the problem; only switching strategy does. GATE EVERY SCALING .df(), NOT JUST THE KD-TREE FRAME — this applies inside the DOESN'T-FIT path too, where the candidate/leaf reads scale with the data: whenever you are about to \`.df()\` a temp table you just built from the remote scan (a search-area / candidate_buildings pull, a leaf-cell read), first \`n = duckdb.sql("SELECT COUNT(*) FROM <that_table>").fetchone()[0]\` and \`assert_fits(n, cols=<#numeric cols you pull>)\`. The classic leak: an isolated cell's NEAREST occupied neighbour can be a dense METRO edge, so a search box around it returns MILLIONS of rows — that unguarded \`cand_df = duckdb.sql("SELECT rowid, lon, lat FROM candidate_buildings").df()\` is exactly what OOM-killed a USA run at ~18 min. If assert_fits raises there, sub-grid that one dense cell (a finer GROUP BY restricted to its bbox) and read only the sub-cell on the isolated point's facing side — never the whole box. ENFORCED — \`.df()\` IS HARD-CAPPED: a \`.df()\` that would pull too many rows into pandas RAISES immediately (before allocating), with a type-aware limit — generous for a numeric-only frame (rowid,lon,lat), tight for any frame carrying string/struct columns (id, names, class, height — these explode in pandas). So an unguarded region/point read fails fast telling you to reduce in DuckDB instead of OOM-killing the container. Do NOT fight it by chunking the same wide pull — obey it: keep the reduction in SQL (COUNT/GROUP BY/ORDER BY LIMIT k), \`.df()\` only the small result, pull ONLY numeric coordinates for a KD-tree, and hydrate attributes for the top-N winners afterward. Backstop (not a substitute for the gate): DuckDB is also capped to spill to disk, and a memory watchdog aborts if the pandas side still climbs past ~85% of the cap — so a doomed approach fails fast instead of burning 18 minutes.
CANONICAL SKELETON — for a bounded-region nearest/farthest-neighbor superlative, ADAPT THIS EXACT SHAPE rather than re-deriving it from the prose below (the prose explains WHY each line is written this way). The ONE line that OOM-kills the run when you get it wrong is the .df() feeding cKDTree: it is rowid+lon+lat and NOTHING else. Get this right on the FIRST attempt — an OOM here costs a multi-minute remote re-scan on retry.
    # region_buildings: TEMP TABLE already materialized (bbox pre-filter + ST_Contains bbox-center point),
    # with display cols kept IN DuckDB: SELECT (bbox.xmin+bbox.xmax)/2 AS lon, (bbox.ymin+bbox.ymax)/2 AS lat,
    #   id, names.primary AS name, class, height FROM data WHERE <bbox literals> AND ST_Contains(...)
    import numpy as np, duckdb
    from scipy.spatial import cKDTree
    from math import radians, cos
    n = duckdb.sql("SELECT COUNT(*) FROM region_buildings").fetchone()[0]
    assert_fits(n, cols=3, factor=4.0, what="the KD-tree coords frame")   # <== GATE: raises → take the DOESN'T-FIT path instead. Never wrap in try/except to force the direct path.
    c = duckdb.sql("SELECT rowid, lon, lat FROM region_buildings").df()   # <== 3 NUMERIC cols ONLY. Adding id/name/class/any string here IS the OOM.
    lat0 = radians(float(c["lat"].mean()))
    x = c["lon"].to_numpy() * cos(lat0) * 111320.0
    y = c["lat"].to_numpy() * 111320.0
    d, _ = cKDTree(np.column_stack([x, y])).query(np.column_stack([x, y]), k=2, workers=-1)
    nn_m = d[:, 1]                                       # nearest-neighbor distance, METERS
    N = 20
    top = np.argpartition(nn_m, -N)[-N:]
    top = top[np.argsort(nn_m[top])[::-1]]              # rank 1 = most isolated (largest NN distance)
    ids = ",".join(str(r) for r in c["rowid"].to_numpy()[top])
    # Hydrate ONLY the ~N winners by rowid, locally (never re-read the remote source):
    win = duckdb.sql(f"SELECT rowid, id, name, class, height, lon, lat FROM region_buildings WHERE rowid IN ({ids})").df()
    # WHERE-IN returns rows in ARBITRARY order — re-attach distances BY ROWID, do not zip by position:
    nn_by_rowid = {int(c["rowid"].to_numpy()[t]): float(nn_m[t]) for t in top}
    win["nn_dist_m"] = win["rowid"].map(nn_by_rowid)
    win = win.sort_values("nn_dist_m", ascending=False).reset_index(drop=True)   # rank 1 first
    # win now has the top-N with names/coords for results + the map layer (tag rank / is_winner).
    # WINNER RESULT DICT — coerce every numeric attribute with the preloaded safe_float()/safe_int();
    # NEVER hand-roll \`float(row['num_floors']) if row['num_floors'] and not np.isnan(...)\` — that throws
    # on None/blank/string/numpy values (a nullable field like num_floors/height IS often null) and has
    # crashed otherwise-successful runs at the finish line. e.g.
    #   best = win.iloc[0]
    #   results["answer"] = {"name": best["name"], "height_m": safe_float(best["height"]),
    #                        "num_floors": safe_int(best["num_floors"]), "nn_dist_m": safe_float(best["nn_dist_m"])}
ENGINE-FIRST — DuckDB streams and spills to disk, so it processes FAR more than fits in RAM; pandas does not. Do the heavy work (filter, aggregate, rank, distance) in DuckDB SQL and .df() only SMALL results. The sandbox has ${sandboxMemoryGb ? `a HARD memory cap of ~${sandboxMemoryGb} GB (the container is killed the instant it exceeds this)` : "limited RAM"}, and a large region can be MILLIONS of rows — loading them all (especially string columns) into pandas gets OOM-KILLED ("Killed"). The sandbox ALSO caps DuckDB's scan \`threads\` and sets \`preserve_insertion_order=false\` for you — because a BILLIONS-row REMOTE parquet scan OOMs on DuckDB's own per-thread row-group read/decompress buffers (which \`memory_limit\` does NOT bound), even when the GROUP-BY output is tiny (OBSERVED: 3x 20-25min OOMs on a USA superlative whose cells+KD-tree were provably small — the engine's scan buffers were the cause). Do NOT add \`SET threads=<high>\` — that re-introduces the scan-buffer OOM; the low default is deliberate.
MEMORY-SAFE KD-tree (MANDATORY on a large region — a wide .df() over millions of rows is THE OOM, and runs get killed for exactly this): the DataFrame you pass to cKDTree must contain ONLY numeric columns. Pull JUST the coordinates: df = duckdb.sql("SELECT lon, lat FROM region_buildings").df() — 2 numeric cols, so tens of millions fit. NEVER select id/class/subtype/height or any string/attribute column into this frame (e.g. do NOT write \`SELECT id, lon, lat, subtype, class, ... FROM region_buildings\`.df() — that is the OOM). Do NOT add \`row_number() OVER ()\` (or any un-partitioned/global window) to manufacture a key — an unpartitioned window is a single-threaded PIPELINE BREAKER that funnels the whole scan through one thread (measured: it turned a ~4-min materialize into an 18-min+ timeout). You don't need a manufactured key: pull DuckDB's free \`rowid\` alongside the coords (df = duckdb.sql("SELECT rowid, lon, lat FROM region_buildings").df()) — the top-N positions give you their rowids. Build the tree, take the top-N positions, THEN hydrate full attributes for ONLY those rows. \`rowid\` IS TABLE-ONLY — it exists ONLY because region_buildings is a MATERIALIZED temp table (CREATE TEMP TABLE …). It does NOT exist on a \`read_parquet(...)\` scan or a VIEW over one: \`SELECT rowid FROM read_parquet(...)\` (or from the \`data\` view) fails with "Binder Error: Referenced column rowid not found in FROM clause". So NEVER select rowid straight from the remote source — materialize into a temp table first, then rowid is valid on THAT table. And a rowid is per-scan positional, NOT a stable identity: a rowid from one scan is meaningless in any OTHER (re-)scan, so you can only use it to hydrate from the SAME temp table you read it from — to hydrate across a fresh read, key on the stable \`id\` column (or exact lon/lat) instead. For a BOUNDED region (a named region / bbox subset — the usual case), materialize the display columns INTO region_buildings in the ONE pass (a bounded subset, so affordable) — but they STAY in DuckDB: they reach pandas ONLY in the final winner hydration, NEVER in the KD-tree frame (which stays rowid+lon+lat). Hydrate the ~N winners LOCALLY by rowid, NAMING the columns (never SELECT *): duckdb.sql(f"SELECT id, names.primary AS name, class, height FROM region_buildings WHERE rowid IN ({top_ids})").df() — do NOT re-read the remote source. OVERTURE COLUMN TRAP: \`names\` is a nested STRUCT, not a string — select \`names.primary AS name\` (materialize it that way too: put \`names.primary AS name\` in region_buildings, never the raw \`names\`). Pulling the raw \`names\` struct into a DataFrame is a top OOM cause (a struct explodes into nested Python objects over millions of rows — this exact mistake OOM-killed a California run), and \`str(row['names'])\` on the struct is garbage. Same for any struct/list/map column: project the scalar field you need, never the container. A second REMOTE bbox read to hydrate a MOST-ISOLATED top-N is also a trap: those winners sit in wide-span row groups that defeat bbox pruning, so it re-reads huge row groups and times out (measured on California). Only a genuinely UNBOUNDED scan (no region) falls back to the second remote read. datasets['main'] gets the bounded top-N (or a sample), never the full frame.
PROJECT TO METERS FIRST — a KD-tree on raw lon/lat DEGREES is geographically distorted: a longitude degree shrinks with latitude, so degree-space distance mis-ranks neighbors (badly across a wide latitude span like a whole state/country) and can pick the WRONG most-isolated point. Convert to an equal-meter space before building the tree: lat0 = radians(mean_lat); x = lon * cos(lat0) * 111320; y = lat * 111320; cKDTree(column_stack([x, y])). Then the query distances are already ~meters (refine the reported top-N with an exact haversine/ST_Distance_Sphere if you want). NEVER build the tree on unscaled lon/lat. CAST INTERPOLATED FLOAT CONSTANTS TO ::DOUBLE IN SQL — if you PRECOMPUTE a factor in Python (e.g. \`coslat0 = cos(lat0)\`) and f-string it into DuckDB arithmetic, a bare high-precision literal like \`0.7071067811865476\` is typed DECIMAL(16,16), and DECIMAL×DECIMAL (e.g. \`{coslat0}*111320.0\`) overflows DECIMAL(18): \`OutOfRangeException: Overflow in multiplication of DECIMAL(18)\` (OBSERVED — killed a USA grid-cell build after an 8-min clean scan). FIX: either keep \`cos({lat0})\` INSIDE the SQL (the cos() result is DOUBLE, so the product stays DOUBLE), or cast every interpolated coordinate constant — \`({coslat0}::DOUBLE)*111320.0\`, \`.../{s}::DOUBLE\` — so the meter/cell math is DOUBLE, never DECIMAL.
EXTREME SCALE (coords don't even fit): do NN in DuckDB with a GRID self-join — bucket points into grid cells (FLOOR(lon/cell), FLOOR(lat/cell)), join a point only to points in the same or the 8 adjacent cells, and MIN(ST_Distance_Sphere(...)) per point. This is spatially correct and streams. For the FARTHEST/loneliest, points with no neighbor in the window are the candidates — widen the window (or increase the cell size) for those so their true NN distance is found, not dropped.
PLANET-SCALE / DOESN'T-FIT superlative (in-scope N too big to pull into pandas — USA ~130M, planet 2.5B): the fine-pass \`.df()\` is THE OOM (OBSERVED: a 10°-grid USA run climbed 28 min then OOM'd; "coords-only" does NOT save you because cKDTree.query(k=2) adds two more N×2 arrays — several GB). So NEVER materialize the tail — COUNT it in DuckDB, coarse-to-fine, and pull only the tiny survivor set into pandas. A most-isolated building sits in an empty disc, so you only need the sparse tail — and you FIND it by counting cells, not by reading points. (1) L0 DENSITY from footers (free, ~seconds): parquet_metadata('<same glob>') → per-row-group bbox (path_in_schema IN ('bbox, xmin','bbox, xmax','bbox, ymin','bbox, ymax'), CAST(stats_min/stats_max AS DOUBLE)) + row_group_num_rows → coarse density. Use it ONLY to bound WHERE to look (approximate — row-group boxes OVERLAP, so it is a conservative pre-filter, NOT the answer; do NOT read points by those boxes — that leaked and OOM'd). (2) EXACT CELL COUNTS via GROUP BY — the crux, and OOM-proof because it COUNTS, never materializes. Bucket each building's bbox-CENTER into a QUADTREE cell in METER space and GROUP BY it (s = cell size in metres, lat0 = region mean-lat in radians):
    cells = duckdb.sql(f'''SELECT
        floor(((bbox.xmin+bbox.xmax)/2.0)*cos({lat0})*111320.0/{s}) AS cx,
        floor(((bbox.ymin+bbox.ymax)/2.0)*111320.0/{s})            AS cy,
        count(*) AS occ
      FROM data WHERE <candidate-region bbox predicate>
      GROUP BY cx, cy''').df()
  Output = ONE row per occupied cell (tens of thousands), even if the read touched 100M+ buildings — DuckDB streams/spills the read, NOTHING lands in pandas. THIS is why it cannot OOM. Pick s SMALLER than the expected answer and LARGER than typical spacing; when unknown start coarse (≈ region_span/50) and let step 3 refine. (3) BRANCH-AND-BOUND on the small cells table (pure numpy, NO data reads): for each cell k = Chebyshev grid-distance to the nearest OTHER occupied cell (search over the occupied (cx,cy) set). UB = s·√2 if occ≥2 else (k+1)·s·√2 — THE occ CHECK IS THE #1 CORRECTNESS BUG WHEN OMITTED: a cell with occ≥2 holds two buildings INSIDE it (≤ one diagonal apart), so NO building in it can be more isolated than ~s·√2; ranking cells by cell-to-cell distance ALONE (using (k+1)·s·√2 for every cell) picks a REMOTE CLUSTER over a lone building (OBSERVED: "most isolated building in California" returned an offshore island's dock with a 103 m neighbour — an occ-MANY island cell that is merely far from the mainland — instead of a lone desert building kilometres from anything). The most-isolated building is ALMOST ALWAYS in an occ==1 cell; a high-occ cell, however remote, holds buildings close to EACH OTHER. Compute and prune by the occ-AWARE UB (\`ub = s*1.4142 if occ>1 else (k+1)*s*1.4142\`), never (k+1)·s·√2 for all cells — and if a candidate's exact NN comes back suspiciously small (≲ s·√2) for a "most isolated" query, it was a cluster, not the answer. Seed best-confirmed B by exact-computing (step 4) the cell with the largest (k−1)·s. KEEP cells with UB ≥ B, DROP the rest — every dense cell prunes once s·√2 < B. If little prunes (s too coarse, dense cells survive), REFINE: re-run the step-2 GROUP BY at s/2 restricted to the surviving cells' bboxes; repeat until survivors are few. (4) LEAF exact NN — this is a POINT-ANCHORED nearest-neighbour query per candidate, NOT a region materialization. A survivor cell holds ~1 isolated building q; you need the SINGLE nearest building to q, not all points in a ring. Do NOT read the whole ceil(UB/s) ring into pandas and do NOT accumulate rings across survivors (both OOM: an isolated q's nearest occupied neighbour may BE a dense metro edge, so its ring overlaps millions — OBSERVED, this exact leaf read OOM'd the USA run at ~28 min AFTER the counts succeeded). Instead: (a) read q's own cell's points (sparse → tiny). (b) Use the CELL COUNTS you already have (no data read) to find the nearest OTHER occupied cell to q by increasing Chebyshev radius. (c) Read ONLY that nearest occupied cell. If it is DENSE (high occ — a metro edge), do NOT read it whole: sub-grid THAT ONE cell (a finer GROUP BY restricted to its bbox) and read only the sub-cell on q's facing side — you need the nearest POINT, not the metro. (d) COMPUTE THE NN AS A DuckDB SCALAR AGGREGATE — do NOT pull neighbour points into pandas at all. Per candidate q, run ONE query that returns ONE number: \`SELECT min(ST_Distance_Sphere(ST_Point({qlon}, {qlat}), ST_Point((bbox.xmin+bbox.xmax)/2.0, (bbox.ymin+bbox.ymax)/2.0))) FROM data WHERE bbox.xmin BETWEEN {lo} AND {hi} AND bbox.ymin BETWEEN {lo} AND {hi} AND <exclude q itself>\` → \`.fetchone()[0]\`. NEVER \`read_bbox(...).df()\` a neighbour cell's raw point cloud (even "capped at 300k" × 8 neighbour cells per candidate, iterated over many candidates, is the OOM — OBSERVED: a leaf that pulled up to 8 neighbour cells' points into pandas and did haversine in numpy drove a USA run to the memory cap) and NEVER build a cKDTree over a ring (that O(n²)/materialization is the trap). The scalar aggregate streams inside DuckDB and lands ONE float in Python — peak memory is O(1) per candidate regardless of how dense the neighbour cell is. Keep a running best B; skip any survivor whose UB < B without reading. Read the neighbour cell UNFILTERED by the region polygon so a true nearest neighbour just across a border still counts (fixes the nearest-IN-region overstatement of a polygon-only KD-tree). Winner = max confirmed NN; top-K = K largest. Only q's cell + the one nearest occupied (sub-)cell per survivor reach pandas (a few thousand points TOTAL) → peak memory ≈ a small-region run, regardless of N. COUNTRY = POLYGON ON THE CELLS, NOT THE 100M BUILDINGS (the recurring "answered with a Canadian building" bug): for a named country/region, a per-row ST_Contains over 100M+ buildings in the coarse GROUP BY IS too slow — so the tempting shortcut is a raw bbox, but the USA bbox (lon[-180,-60], lat up to 72) blankets Canada, Mexico and Greenland, and the emptier Canadian Arctic then DOMINATES the isolation ranking (OBSERVED: "most isolated in the USA" over the raw box surfaces neighbouring-country buildings). Apply the polygon to the SMALL sets ONLY: (i) coarse-GROUP-BY over the bbox (fast, no polygon), (ii) then keep only IN-COUNTRY cells by ST_Contains-ing the ~thousands of occupied CELL centroids against the (simplified) region polygon — register the tiny cells table back into DuckDB, e.g. \`SELECT * FROM cells WHERE ST_Contains((SELECT geom FROM region), ST_Point(lon_c, lat_c))\` — BEFORE you rank candidates, and (iii) verify the final WINNER building is ST_Contains(region) (one point). Keep the NN NEIGHBOUR search UNFILTERED by the polygon so a nearest neighbour just across the border still counts. That is a few thousand + one polygon tests, never 100M — correct AND cheap. SCOPE TRAP: a region bbox crossing the antimeridian (USA + Aleutians) makes min(xmin)…max(xmax) span the globe — split at ±180 (or clamp the GRID to the main landmass, e.g. lon[-125,-66] for contiguous US) and rely on the cell polygon filter, never one raw bbox. BUT that grid clamp is for the GROUP-BY window ONLY — do NOT feed it into the boundary-polygon build's bbox filter: the country's single boundary row has bbox.xmin ≈ -180, so a -125 clamp drops it, ST_Union_Agg yields NULL, and every cell fails ST_Contains → 0 in-region cells and "no candidate" (OBSERVED exactly this). Build \`region\` from the country's FULL extent (see the two-phase BOUNDARY LOOKUP rule + its NULL-geom assert), then ST_Contains the clamped grid's cells against it. WINNER HYDRATION (the DOESN'T-FIT path materialized nothing, so attributes MUST come from a second remote read — its SHAPE decides whether it takes seconds or hours): issue ONE query PER winner, each with an AND-only bbox conjunction (\`WHERE bbox.xmin BETWEEN {lon-eps} AND {lon+eps} AND bbox.ymin BETWEEN {lat-eps} AND {lat+eps}\`, eps ≈ 0.002, ORDER BY |center−winner| LIMIT 1) — a loop over the top-K (or a UNION ALL of the per-box queries). NEVER combine the winners' boxes with OR into one WHERE: an OR of multi-column conjunctions CANNOT be pushed into parquet zonemap pruning, so the "tiny bbox-pruned read" silently degrades to a FULL scan of the theme (OBSERVED: a 5-box OR turned the final hydration of a USA run into a 10+ hour full re-scan and the run had to be killed — the per-box loop version of the same hydration ran in seconds). Each AND-only box prunes to a handful of row groups; K sequential tiny reads beat one un-prunable batched read by ~1000x. And do NOT precede the hydration with a COUNT(*) of the same predicate against the remote view — on a remote source the count is itself a full pass (the assert_fits/COUNT gate is for temp tables you already materialized); a per-box LIMIT 1 read is bounded by construction, and the .df() hard cap backstops it — check len(df) after the fetch instead. Set results["analysis_scope"] to the resolution reached + that the dense majority was excluded (it cannot hold an isolated outlier). This is the SPATIAL case of the EXTREME/SELECTIVE strategy (see SCAN STRATEGY) — a DENSE-selecting superlative flips it (keep HIGH-occ cells); a global AGGREGATE over every row genuinely needs the full scan → bound+disclose.`;
  },
};

---
name: spatial-clustering
description: Point-pattern readouts — are buildings/POIs clustered, random, or dispersed? Clark-Evans index with significance, never an eyeballed density verdict
order: 230
triggers:
  question:
    [
      "cluster",
      "dispers",
      "evenly spread",
      "evenly spaced",
      "spread out",
      "point pattern",
      "packed together",
      "sprawl",
    ]
reviewRules: |
  CLUST-EYEBALL — flag when a clustered/dispersed/random verdict about point locations is stated WITHOUT computing skill_lib.spatial_clustering.clark_evans — a density map or a bare mean nearest-neighbor distance conflates density with pattern (dense-but-random reads as "clustered").
  CLUST-SAMPLE — flag when clark_evans or nearest-neighbor statistics are computed over a sampled/LIMIT'd subset of the region's points; thinning points inflates every NN distance and biases R toward "dispersed". (Downsampling ONLY the map render is fine and encouraged.)
failureHints:
  - pattern: "cKDTree|KDTree|nearest|clark"
    hint: "Build the tree over a coords-only frame (id, lon, lat — drop geometry/name/tag columns before .df()). If the region's points still do not fit, SHRINK THE REGION (or split it and report per sub-region) rather than sampling — Clark-Evans over a sample is biased toward dispersed."
---

## Guidance

Clustering/dispersion questions about point locations (building centroids,
POIs, stores):

- HYDRATE ONE BOUNDED REGION first, per the geo rules (polygon for named
  areas, one AND-only bbox per region), and pull ONLY id + lon + lat.
  City/metro scale is the target — the coords frame AND the KD-tree's k=2
  query output must fit in RAM, so millions of points are fine, a whole
  country is not.
- The VERDICT comes from the preloaded clark_evans, never from eyeballing a
  map: R < 1 clustered, R ≈ 1 random (CSR), R → 2.15 perfectly dispersed
  (hexagonal lattice). Report n, R, z and p together —
  "R=0.42 (n=181,204, z=-310, p≈0)" is an answer; "looks clustered" is not.
- NEVER compute the statistic over a sample of the points. Sampling thins
  density, inflates every nearest-neighbor distance, and biases R upward.
  Downsample only for the map RENDER, and say the statistic used all points.
- COMPARING REGIONS: compare R values, never raw mean NN distances — mean NN
  distance is mostly a density readout (downtown always "beats" suburbs); R
  is normalized by density, so it isolates the pattern.
- The study area is the points' convex hull (Donnelly edge correction is
  applied). For elongated or coastal regions the hull overshoots into empty
  water/land and drags R down — say so when the region has that shape, and
  treat modest |z| near R ≈ 1 as "consistent with random", not a verdict.
- Chart: the map of points (render-downsampled is fine) so the pattern is
  visible; a nearest-neighbor distance histogram via nn_distances_m makes a
  good second panel, with isolated points (top-percentile NN distance)
  called out.
- results["analysis_scope"] states the region, n, and the area basis, e.g.
  "Seattle city polygon, 181,204 building centroids, convex-hull area 217 km²".

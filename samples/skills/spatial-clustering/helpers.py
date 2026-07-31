"""Point-pattern helpers — Clark-Evans clustering index with significance over lon/lat point sets."""

import math

import numpy as np
from scipy.spatial import ConvexHull, cKDTree


def clark_evans(lons, lats):
    """Clark-Evans nearest-neighbor index: {n, area_km2, density_per_km2, mean_nn_m, expected_nn_m, R, z, p_value}.

    R < 1 clustered, R ~= 1 random (CSR), R -> 2.15 perfectly dispersed.
    Study area = convex hull of the points; the expectation uses the Donnelly
    (1978) edge correction. Pass EVERY point in the hydrated region —
    sampling thins density and biases R toward dispersed.
    """
    none = {"n": 0, "area_km2": None, "density_per_km2": None, "mean_nn_m": None,
            "expected_nn_m": None, "R": None, "z": None, "p_value": None}
    xy = _local_xy_m(lons, lats)
    n = len(xy)
    if n < 10:
        return {**none, "n": n}
    try:
        hull = ConvexHull(xy)
    except Exception:  # degenerate input (collinear points)
        return {**none, "n": n}
    # In 2D scipy hulls, .volume is the area and .area is the perimeter.
    area, perim = hull.volume, hull.area
    if area <= 0:
        return {**none, "n": n}

    d, _ = cKDTree(xy).query(xy, k=2)
    mean_nn = float(d[:, 1].mean())
    expected = 0.5 * math.sqrt(area / n) + (0.0514 + 0.041 / math.sqrt(n)) * perim / n
    var = 0.0703 * area / n**2 + 0.037 * perim * math.sqrt(area) / n**2.5
    z = (mean_nn - expected) / math.sqrt(var)
    return {
        "n": n,
        "area_km2": area / 1e6,
        "density_per_km2": n / (area / 1e6),
        "mean_nn_m": mean_nn,
        "expected_nn_m": expected,
        "R": mean_nn / expected,
        "z": z,
        "p_value": math.erfc(abs(z) / math.sqrt(2)),
    }


def nn_distances_m(lons, lats):
    """Each point's nearest-neighbor distance in meters (numpy array) — for histograms and isolated-point callouts."""
    xy = _local_xy_m(lons, lats)
    if len(xy) < 2:
        return np.array([])
    d, _ = cKDTree(xy).query(xy, k=2)
    return d[:, 1]


def _local_xy_m(lons, lats):
    # Equirectangular projection to meters around the points' mean latitude —
    # sub-percent distance error at city/metro extents, which is all this
    # skill's guidance allows.
    lons = np.asarray(lons, dtype=float)
    lats = np.asarray(lats, dtype=float)
    lat0 = math.radians(float(lats.mean())) if len(lats) else 0.0
    x = np.radians(lons) * math.cos(lat0) * 6_371_000.0
    y = np.radians(lats) * 6_371_000.0
    return np.column_stack((x, y))

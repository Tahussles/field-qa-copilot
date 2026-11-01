"""Flat-earth geometry helpers. Accurate to well under a metre at city scale."""

import math
from random import Random

Point = tuple[float, float]  # (lng, lat)

M_PER_DEG_LAT = 110_574.0
_M_PER_DEG_LNG_AT_EQUATOR = 111_320.0


def _m_per_deg_lng(lat: float) -> float:
    return _M_PER_DEG_LNG_AT_EQUATOR * math.cos(math.radians(lat))


def offset(point: Point, east_m: float, north_m: float) -> Point:
    lng, lat = point
    return (lng + east_m / _m_per_deg_lng(lat), lat + north_m / M_PER_DEG_LAT)


def distance_m(a: Point, b: Point) -> float:
    mean_lat = (a[1] + b[1]) / 2
    return math.hypot((b[0] - a[0]) * _m_per_deg_lng(mean_lat), (b[1] - a[1]) * M_PER_DEG_LAT)


def contains(ring: list[list[float]], point: Point) -> bool:
    """Ray-casting point-in-polygon test for a closed ring."""
    x, y = point
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def distance_to_edge_m(ring: list[list[float]], point: Point) -> float:
    def local(q) -> tuple[float, float]:
        return ((q[0] - point[0]) * _m_per_deg_lng(point[1]), (q[1] - point[1]) * M_PER_DEG_LAT)

    best = math.inf
    for a, b in zip(ring, ring[1:]):
        (ax, ay), (bx, by) = local(a), local(b)
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def random_point_in(rng: Random, ring: list[list[float]], margin_m: float) -> Point:
    """Uniform point inside the ring, at least margin_m from every edge."""
    lngs = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    while True:
        p = (rng.uniform(min(lngs), max(lngs)), rng.uniform(min(lats), max(lats)))
        if contains(ring, p) and distance_to_edge_m(ring, p) >= margin_m:
            return p


def scatter(rng: Random, ring: list[list[float]], center: Point, sd_m: float, max_m: float) -> Point:
    """Gaussian scatter around center, truncated at max_m and kept inside the ring."""
    while True:
        east, north = rng.gauss(0, sd_m), rng.gauss(0, sd_m)
        if math.hypot(east, north) <= max_m:
            p = offset(center, east, north)
            if contains(ring, p):
                return p

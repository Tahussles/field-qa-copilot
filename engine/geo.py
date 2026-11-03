"""Great-circle distance, point in polygon, distance to a polygon's boundary."""

import math

EARTH_RADIUS_M = 6_371_008.8
M_PER_DEG_LAT = math.pi * EARTH_RADIUS_M / 180

Ring = tuple[tuple[float, float], ...]  # closed ring of (lng, lat)


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def contains(ring: Ring, lng: float, lat: float) -> bool:
    """Ray casting; a point exactly on an edge may land either side."""
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        if (y1 > lat) != (y2 > lat) and lng < x1 + (lat - y1) * (x2 - x1) / (y2 - y1):
            inside = not inside
    return inside


def distance_to_ring_m(ring: Ring, lng: float, lat: float) -> float:
    """Metres from the point to the nearest point on the ring's edges.

    The nearest point of each edge is found in a flat frame around that edge
    (edges are a few km long), then measured with haversine, so the result holds
    both next to the boundary and from another continent.
    """
    best = math.inf
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        kx = math.cos(math.radians((y1 + y2) / 2))
        ax, ay, bx, by, px, py = x1 * kx, y1, x2 * kx, y2, lng * kx, lat
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        t = 0.0 if length == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length))
        best = min(best, haversine_m(lat, lng, y1 + t * (y2 - y1), x1 + t * (x2 - x1)))
    return best

"""same_spot: an enumerator logged several interviews at one spot on the same local day.

Participants report from home, so the check never applies to them.
"""

from ..geo import haversine_m
from ..model import CheckResult, Context, Submission, iso_utc

KEY = "same_spot"
_FLOAT_SLACK_M = 1e-6  # so a neighbour exactly on the radius counts as within it


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    weight = params.weights[KEY]
    if ctx.contributor.kind != "enumerator":
        return CheckResult(KEY, False, weight, {
            "not_applicable": True,
            "reason": "participants report from home",
        })
    if target.lat is None or target.lng is None:
        return CheckResult(KEY, False, weight, {"missing": "location"})

    neighbours = []
    for other in ctx.same_contributor_day:
        if other.lat is None or other.lng is None:
            continue
        distance = haversine_m(target.lat, target.lng, other.lat, other.lng)
        if distance <= params.same_spot_radius_m + _FLOAT_SLACK_M:
            neighbours.append((distance, other))
    neighbours.sort(key=lambda n: (n[0], n[1].id))
    return CheckResult(KEY, len(neighbours) >= params.same_spot_min_neighbours, weight, {
        "radius_m": params.same_spot_radius_m,
        "min_neighbours": params.same_spot_min_neighbours,
        "local_date": target.local_date(ctx.tz).isoformat(),
        "neighbour_count": len(neighbours),
        "neighbours": [
            {"submission_id": other.id, "distance_m": round(distance, 1), "captured_at": iso_utc(other.captured_at)}
            for distance, other in neighbours
        ],
    })

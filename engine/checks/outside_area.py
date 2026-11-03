"""outside_area: the GPS point is outside the contributor's assigned area, by more than GPS error.

Fieldwork is assigned by area, so an interview recorded outside it is either a
mistake worth a call or a form filled in somewhere else. A fix within
max(gps_accuracy_m, outside_area_min_tolerance_m) of the boundary does not fire:
that is the phone's own error. Within outside_area_far_m it weighs
outside_area_near_weight (corroboration: GPS tails at a boundary household reach
a few hundred metres); beyond it, the full weight. Evidence gives the distance to
the boundary (metres nearby, km when far), the accuracy, the tolerance and the area.
"""

from .. import geo
from ..model import CheckResult, Context, Submission

KEY = "outside_area"


def _label(metres: float) -> str:
    if metres < 1000:
        return f"{round(metres)} m"
    km = metres / 1000
    return f"{km:.1f} km" if km < 100 else f"{round(km):,} km"


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    weight = params.weights[KEY]
    area = ctx.contributor.area
    if area is None:
        return CheckResult(KEY, False, weight, {"missing": "assigned area"})
    if target.lat is None or target.lng is None:
        return CheckResult(KEY, False, weight, {"missing": "GPS point", "area": area.name})
    if geo.contains(area.ring, target.lng, target.lat):
        return CheckResult(KEY, False, weight, {"area": area.name, "inside": True})
    metres = geo.distance_to_ring_m(area.ring, target.lng, target.lat)
    tolerance = max(target.gps_accuracy_m or 0.0, params.outside_area_min_tolerance_m)
    evidence = {"area": area.name, "inside": False, "distance_m": round(metres), "distance": _label(metres),
                "gps_accuracy_m": target.gps_accuracy_m, "tolerance_m": round(tolerance, 1)}
    if metres <= tolerance:
        return CheckResult(KEY, False, weight, {**evidence, "within_gps_error": True})
    far = metres > params.outside_area_far_m
    return CheckResult(KEY, True, weight if far else params.outside_area_near_weight,
                       {**evidence, "band": "far" if far else "near"})

"""outside_area: the GPS point is outside the contributor's assigned area.

Fieldwork is assigned by area, so an interview recorded outside it is either a
mistake worth a call or a form filled in somewhere else. Evidence gives the
distance to the area's boundary (metres nearby, km when far) and the area name.
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
    weight = ctx.params.weights[KEY]
    area = ctx.contributor.area
    if area is None:
        return CheckResult(KEY, False, weight, {"missing": "assigned area"})
    if target.lat is None or target.lng is None:
        return CheckResult(KEY, False, weight, {"missing": "GPS point", "area": area.name})
    if geo.contains(area.ring, target.lng, target.lat):
        return CheckResult(KEY, False, weight, {"area": area.name, "inside": True})
    metres = geo.distance_to_ring_m(area.ring, target.lng, target.lat)
    return CheckResult(KEY, True, weight, {"area": area.name, "inside": False, "distance_m": round(metres),
                                           "distance": _label(metres)})

"""Fixed facts about the synthetic wave: dates, places, defaults and fraud actors.

Area boundaries are synthetic. They are a hand-drawn 3x2 grid over eastern
Kisumu (about lat -0.060 to -0.100, lng 34.770 to 34.825, east of the lake
shore), not official ward or sub-location boundaries.
"""

from datetime import date, timedelta, timezone
from typing import NamedTuple

EAT = timezone(timedelta(hours=3), "EAT")

PROJECT_NAME = "Household Water Access Survey"
PROJECT_REGION = "Kisumu, Kenya"
PROJECT_TIMEZONE = "Africa/Nairobi"  # EAT, UTC+3, no daylight saving
# The project's own "now" for the demo: the morning of the live day (Oct 31, 08:00 EAT).
PROJECT_AS_OF = "2026-10-31T05:00:00+00:00"
# The live day. During its replay "today" stays here even once the field clock
# passes midnight (enumerators sync the next morning).
PROJECT_DAY_PIN = "2026-10-31"
WAVE = 2
FIELD_DAYS = tuple(date(2026, 10, 25) + timedelta(days=i) for i in range(6))

WATER_SOURCES = ("piped_home", "public_tap", "borehole", "vendor", "river")

# Order of the 8 satisfaction answers (1 = very dissatisfied, 5 = very satisfied).
SATISFACTION_ITEMS = (
    "reliability",
    "distance",
    "cost",
    "water_quality",
    "waiting_time",
    "safety",
    "opening_hours",
    "overall",
)

ENUMERATORS_PER_AREA = 5
PARTICIPANTS_PER_AREA = 10

# Enumerators with planted fraud. Participant fraud actors (the multi-account
# ring and the burst account) are picked from the seed.
CURBSTONE = "E07"
SPEEDER = "E14"
COPYPASTE = "E22"
CONTRADICTION = "E11"
NIGHT = "E19"
FRAUD_ENUMERATORS = {
    CURBSTONE: "curbstone",
    SPEEDER: "speeder",
    COPYPASTE: "copypaste",
    CONTRADICTION: "contradiction",
    NIGHT: "night",
}
FRAUD_TYPES = (*FRAUD_ENUMERATORS.values(), "multi_account", "burst")

# Shared grid vertices as (lng, lat), north row first. Interior vertices are
# nudged so the areas are irregular quadrilaterals rather than perfect squares.
_GRID = (
    ((34.7700, -0.0600), (34.7885, -0.0612), (34.8068, -0.0596), (34.8250, -0.0608)),
    ((34.7712, -0.0795), (34.7889, -0.0807), (34.8061, -0.0790), (34.8244, -0.0803)),
    ((34.7700, -0.1000), (34.7876, -0.0991), (34.8073, -0.1004), (34.8250, -0.0995)),
)


class AreaSpec(NamedTuple):
    name: str
    row: int
    col: int
    source_weights: tuple[float, ...]  # in WATER_SOURCES order
    landmarks: tuple[str, ...]


AREAS = (
    AreaSpec("Kondele", 0, 0, (0.25, 0.35, 0.05, 0.30, 0.05),
             ("the Kondele roundabout", "Kibuye market", "the Kondele bus stage")),
    AreaSpec("Nyalenda A", 1, 1, (0.15, 0.40, 0.05, 0.30, 0.10),
             ("Nyalenda market", "the Nyalenda health centre", "the Total petrol station")),
    AreaSpec("Manyatta B", 1, 2, (0.20, 0.35, 0.10, 0.30, 0.05),
             ("Manyatta Arab", "the Manyatta mosque", "the water kiosk near the church")),
    AreaSpec("Migosi", 0, 1, (0.30, 0.30, 0.10, 0.25, 0.05),
             ("Migosi market", "Migosi primary school", "the chief's camp")),
    AreaSpec("Kolwa East", 0, 2, (0.08, 0.20, 0.30, 0.22, 0.20),
             ("the Kolwa police post", "the Kolwa East dispensary", "the posho mill")),
    AreaSpec("Railways", 1, 0, (0.35, 0.30, 0.05, 0.25, 0.05),
             ("the old railway station", "the Railways estate gate", "the railway line")),
)


def area_ring(spec: AreaSpec) -> list[list[float]]:
    """Closed GeoJSON exterior ring, counter-clockwise, as [lng, lat] pairs."""
    top_left = _GRID[spec.row][spec.col]
    top_right = _GRID[spec.row][spec.col + 1]
    bottom_right = _GRID[spec.row + 1][spec.col + 1]
    bottom_left = _GRID[spec.row + 1][spec.col]
    return [list(p) for p in (top_left, bottom_left, bottom_right, top_right, top_left)]

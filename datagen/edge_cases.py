"""Edge cases for the checks: small scenarios with what should and should not fire.

A case is proposed by a model (scripts/gen_edge_cases.py), reviewed by a human,
and once accepted runs in pytest (tests/test_edge_cases.py) against the engine,
with no model involved. Every case lives in one small fixed world: two areas,
four contributors, the project's time zone and the engine's default params.

    data/fixtures/edge_cases/proposed/<id>.json   waiting for review
    data/fixtures/edge_cases/accepted/<id>.json   reviewed; pytest runs these
"""

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from engine import CHECK_KEYS, Params, Submission, contributors_with_areas, score_all

ROOT = Path(__file__).resolve().parent.parent
EDGE_CASES = ROOT / "data" / "fixtures" / "edge_cases"
TIMEZONE = "Africa/Nairobi"  # UTC+3 all year

# Two neighbouring square areas in Kisumu, as (lng, lat) rings.
AREAS = {
    "Kondele": ((34.760, -0.090), (34.780, -0.090), (34.780, -0.070), (34.760, -0.070), (34.760, -0.090)),
    "Nyalenda": ((34.740, -0.110), (34.760, -0.110), (34.760, -0.090), (34.740, -0.090), (34.740, -0.110)),
}
ROSTER = {
    "E01": ("enumerator", "Kondele"),
    "E02": ("enumerator", "Nyalenda"),
    "P01": ("participant", "Kondele"),
    "P02": ("participant", "Nyalenda"),
}
WATER_SOURCES = ("piped_home", "public_tap", "borehole", "vendor", "river")

CheckKey = Literal[CHECK_KEYS]  # type: ignore[valid-type]


class CaseSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ref: str = Field(pattern=r"^[a-z][a-z0-9_]{0,15}$")
    contributor: Literal[tuple(ROSTER)]  # type: ignore[valid-type]
    device_id: str = Field(min_length=1, max_length=40)
    captured_at: str
    duration_sec: int = Field(ge=0, le=86_400)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    water_source: Literal[WATER_SOURCES]  # type: ignore[valid-type]
    satisfaction: list[int] = Field(min_length=8, max_length=8)
    open_text: str = Field(max_length=600)
    voice_transcript: str = Field(max_length=1000)  # "" for no voice note

    @field_validator("captured_at")
    @classmethod
    def _aware(cls, value: str) -> str:
        if datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("captured_at needs a UTC offset")
        return value

    @field_validator("satisfaction")
    @classmethod
    def _likert(cls, value: list[int]) -> list[int]:
        if any(v < 1 or v > 5 for v in value):
            raise ValueError("satisfaction answers are 1 to 5")
        return value


class EdgeCase(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{2,70}$")
    check: CheckKey
    kind: Literal["boundary", "adversarial"]
    title: str = Field(min_length=5, max_length=160)
    submissions: list[CaseSubmission] = Field(min_length=1, max_length=15)
    target: str
    should_fire: list[CheckKey]
    should_not_fire: list[CheckKey]
    why: str = Field(min_length=10, max_length=1200)

    @model_validator(mode="after")
    def _consistent(self) -> "EdgeCase":
        refs = [s.ref for s in self.submissions]
        if len(set(refs)) != len(refs):
            raise ValueError("submission refs must be unique")
        if self.target not in refs:
            raise ValueError(f"target {self.target!r} is not one of the submissions")
        if set(self.should_fire) & set(self.should_not_fire):
            raise ValueError("a check cannot both fire and not fire")
        if self.check not in self.should_fire + self.should_not_fire:
            raise ValueError(f"the case is about {self.check}, so it must say whether {self.check} fires")
        return self


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:70]


def world():
    """The contributors (with areas) every case runs against."""
    area_rows = [{"id": name, "name": name, "boundary": {"type": "Polygon", "coordinates": [list(map(list, ring))]}}
                 for name, ring in AREAS.items()]
    contributor_rows = [{"id": f"c-{code}", "code": code, "kind": kind, "area_id": area}
                        for code, (kind, area) in ROSTER.items()]
    return contributors_with_areas(contributor_rows, area_rows)


def run(case: EdgeCase) -> dict[str, bool]:
    """Which checks fire on the case's target, scoring every submission in the case together."""
    subs = [Submission.from_row({
        "id": s.ref, "contributor_id": f"c-{s.contributor}", "device_id": s.device_id, "captured_at": s.captured_at,
        "synced_at": None, "duration_sec": s.duration_sec, "lat": s.lat, "lng": s.lng,
        "answers": {"water_source": s.water_source, "satisfaction": s.satisfaction, "open_text": s.open_text},
        "voice_transcript": s.voice_transcript or None,
    }) for s in case.submissions]
    scored = score_all(subs, world(), Params.from_config({}, timezone=TIMEZONE))
    target = next(s for s in scored if s.submission_id == case.target)
    return {r.key: r.fired for r in target.results}


def mismatches(case: EdgeCase) -> list[str]:
    """How the engine disagrees with the case's expectations; empty when it agrees."""
    fired = run(case)
    return ([f"{k} did not fire" for k in case.should_fire if not fired[k]]
            + [f"{k} fired" for k in case.should_not_fire if fired[k]])


def load(folder: str) -> list[EdgeCase]:
    return [EdgeCase.model_validate(json.loads(p.read_text())["case"])
            for p in sorted((EDGE_CASES / folder).glob("*.json"))]

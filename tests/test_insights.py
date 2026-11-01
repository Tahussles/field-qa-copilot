from datetime import timedelta

from engine import Params, score_all
from engine.insights import area_rates, contributor_stats, hotspots
from engine.metrics import FRAUD_TYPES as METRIC_FRAUD_TYPES
from tests.test_engine import BASE, ENUM, ENUM2, PART, PEOPLE, sub

CONTRIBUTORS = {c.id: c for c in PEOPLE}


def _day(n: int, hour: float):
    return BASE.replace(hour=0) + timedelta(days=n, hours=hour)


def fixture():
    tea_shop = [sub(f"t{d}{i}", ENUM, at=_day(d, 10 + i), north_m=3 * i + d, duration=800)
                for d in (0, 1) for i in range(3)]  # 3 a day for 2 days, within ~10 m
    compound = [sub(f"c{i}", ENUM, at=_day(2, 10 + i), north_m=1000 + 5 * i) for i in range(3)]  # below min count
    night = [sub(f"n{i}", ENUM2, at=_day(0, 22 + 0.4 * i), north_m=5000 + 2 * i, duration=900) for i in range(4)]
    elsewhere = [sub(f"p{i}", PART, at=_day(0, 9 + 2 * i)) for i in range(3)]
    return [*tea_shop, *compound, *night, *elsewhere]


def test_hotspots_group_same_spot_submissions_per_enumerator():
    subs = fixture()
    params = Params()
    found = hotspots(score_all(subs, CONTRIBUTORS, params), subs, CONTRIBUTORS, params)

    assert [(h["contributor_code"], h["count"]) for h in found] == [("E01", 6), ("E02", 4)]
    tea, night = found
    assert tea["days"] == 2 and tea["first_date"] == "2026-10-27" and tea["last_date"] == "2026-10-28"
    assert tea["radius_m"] < 10 and tea["avg_duration_sec"] == 800
    assert tea["mostly_off_hours"] is False
    assert sorted(tea["submission_ids"]) == sorted(s.id for s in subs if s.id.startswith("t"))
    assert night["mostly_off_hours"] is True and night["off_hours_share"] == 1.0


def test_hotspots_respect_min_count():
    subs = fixture()
    params = Params()
    scored = score_all(subs, CONTRIBUTORS, params)
    assert [h["count"] for h in hotspots(scored, subs, CONTRIBUTORS, params, min_count=3)] == [6, 4, 3]


def test_contributor_stats_and_area_rates():
    subs = fixture()
    params = Params()
    scored = score_all(subs, CONTRIBUTORS, params)
    stats = {row["code"]: row for row in contributor_stats(scored, subs, CONTRIBUTORS, params)}
    assert stats["E01"]["submissions"] == 9 and stats["P01"]["submissions"] == 3
    assert stats["E02"]["flagged"] == 4 and stats["E02"]["investigate"] is True
    assert stats["P01"]["flagged"] == 0 and stats["P01"]["investigate"] is False
    assert stats["E02"]["checks_fired"]["off_hours"] == 4

    area_of = {ENUM.id: "Kondele", ENUM2.id: "Migosi", PART.id: "Kondele"}
    rates = {row["area"]: row for row in area_rates(scored, subs, area_of, params)}
    assert rates["Migosi"]["submissions"] == 4 and rates["Migosi"]["flag_rate"] == 1.0
    assert rates["Kondele"]["submissions"] == 12


def test_bands():
    params = Params()
    assert [params.band(s) for s in (0, 0.99, 1.0, 1.99, 2.0, 7.5)] == [
        "clear", "clear", "watch", "watch", "flagged", "flagged"]


def test_fraud_type_lists_agree():
    from datagen.config import FRAUD_TYPES

    assert tuple(FRAUD_TYPES) == METRIC_FRAUD_TYPES

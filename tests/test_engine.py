import ast
import math
import random
import sys
from datetime import datetime, timedelta, timezone
from itertools import count
from pathlib import Path

import pytest

from engine import CHECK_KEYS, Contributor, Params, Submission, score_all, score_incremental
from engine.geo import EARTH_RADIUS_M

ROOT = Path(__file__).resolve().parent.parent
EAT = timezone(timedelta(hours=3))
BASE = datetime(2026, 10, 27, 10, 0, tzinfo=EAT)
LAT, LNG = -0.08, 34.79

ENUM = Contributor("c-e01", "E01", "enumerator")
ENUM2 = Contributor("c-e02", "E02", "enumerator")
PART = Contributor("c-p01", "P01", "participant")
PART2 = Contributor("c-p02", "P02", "participant")
PEOPLE = [ENUM, ENUM2, PART, PART2]
_spread = count(1)


def north(metres: float) -> float:
    """Latitude `metres` due north of LAT, exact for the engine's haversine."""
    return LAT + math.degrees(metres / EARTH_RADIUS_M)


def sub(sid, who=ENUM, *, at=None, minutes=0.0, duration=1800, north_m=None, device=None,
        text=None, satisfaction=None, source="public_tap", voice=None, synced=None) -> Submission:
    captured = at or BASE + timedelta(minutes=minutes)
    # By default every submission sits 2 km from the others, so same_spot stays quiet.
    lat = north(2000 * next(_spread) if north_m is None else north_m)
    return Submission(
        id=sid,
        contributor_id=who.id,
        device_id=device or f"device-{who.code}",
        captured_at=captured,
        synced_at=synced or captured + timedelta(hours=1),
        duration_sec=duration,
        lat=lat,
        lng=LNG,
        answers={
            "water_source": source,
            "satisfaction": satisfaction or [1, 2, 3, 4, 5, 1, 2, 3],
            "open_text": text or f"note {sid}",
        },
        voice_transcript="We fetch from the public tap near the market." if voice is None else voice,
    )


def results(subs, params=None):
    return {s.submission_id: s for s in score_all(subs, PEOPLE, params or Params())}


def result(subs, sid, key, params=None):
    return next(r for r in results(subs, params)[sid].results if r.key == key)


# too_fast ---------------------------------------------------------------------

def test_too_fast_enumerator_boundary():
    subs = [sub("a", duration=719, minutes=0), sub("b", duration=720, minutes=120)]
    assert result(subs, "a", "too_fast").fired
    fast = result(subs, "b", "too_fast")
    assert not fast.fired
    assert fast.evidence["threshold_sec"] == 720 and fast.evidence["contributor_median_sec"] == 719.5


def test_too_fast_participant_boundary():
    subs = [sub("a", PART, duration=179, minutes=0), sub("b", PART, duration=180, minutes=120)]
    assert result(subs, "a", "too_fast").fired
    assert not result(subs, "b", "too_fast").fired


# same_spot --------------------------------------------------------------------

def test_same_spot_fires_with_two_neighbours():
    subs = [sub("a", north_m=0, minutes=0), sub("b", north_m=10, minutes=60), sub("c", north_m=20, minutes=120)]
    hit = result(subs, "a", "same_spot")
    assert hit.fired
    assert [n["submission_id"] for n in hit.evidence["neighbours"]] == ["b", "c"]
    assert [n["distance_m"] for n in hit.evidence["neighbours"]] == [10.0, 20.0]


def test_same_spot_needs_two_neighbours():
    subs = [sub("a", north_m=0, minutes=0), sub("b", north_m=10, minutes=60), sub("c", north_m=500, minutes=120)]
    assert not result(subs, "a", "same_spot").fired


def test_same_spot_radius_boundary():
    on_radius = [sub("a", north_m=0), sub("b", north_m=50, minutes=60), sub("c", north_m=-50, minutes=120)]
    assert result(on_radius, "a", "same_spot").fired
    outside = [sub("a", north_m=0), sub("b", north_m=50.5, minutes=60), sub("c", north_m=-50.5, minutes=120)]
    assert not result(outside, "a", "same_spot").fired


def test_same_spot_only_counts_the_same_local_day():
    late = BASE.replace(hour=23, minute=50)
    subs = [sub("a", north_m=0, at=late), sub("b", north_m=5, at=late + timedelta(minutes=15)),
            sub("c", north_m=10, at=late + timedelta(minutes=30))]  # b and c fall after local midnight
    assert not result(subs, "a", "same_spot").fired


def test_same_spot_never_fires_for_participants():
    subs = [sub(f"p{i}", PART, north_m=0, minutes=90 * i) for i in range(4)]
    for s in subs:
        r = result(subs, s.id, "same_spot")
        assert not r.fired and r.evidence["not_applicable"] is True


# copied_text ------------------------------------------------------------------

def test_copied_text_same_contributor():
    subs = [sub("a", text="The queue at the public tap is long", minutes=0),
            sub("b", text="The queue at the public tap is long", minutes=120)]
    r = result(subs, "a", "copied_text")
    assert r.fired
    assert r.evidence["best_match"]["submission_id"] == "b"
    assert r.evidence["best_match"]["relation"] == "same_contributor"
    assert r.evidence["best_match"]["similarity"] == 1.0
    assert r.evidence["best_match"]["shared_words"] == ["long", "public", "queue", "tap"]


def test_copied_text_same_device_other_contributor():
    subs = [sub("a", PART, device="shared", text="Vendors charge too much for water"),
            sub("b", PART2, device="shared", text="Vendors charge too much for water", minutes=30)]
    r = result(subs, "a", "copied_text")
    assert r.fired and r.evidence["best_match"]["relation"] == "same_device"


def test_copied_text_ignores_unrelated_contributors():
    subs = [sub("a", PART, text="Vendors charge too much for water"),
            sub("b", PART2, text="Vendors charge too much for water", minutes=30)]
    assert not result(subs, "a", "copied_text").fired


def test_copied_text_threshold_boundary():
    at_threshold = [sub("a", text="alpha beta gamma delta"), sub("b", text="alpha beta gamma delta epsilon", minutes=90)]
    assert result(at_threshold, "a", "copied_text").fired  # 4/5 = 0.8
    below = [sub("a", text="alpha beta gamma delta"), sub("b", text="alpha beta gamma delta epsilon zeta", minutes=90)]
    assert not result(below, "a", "copied_text").fired  # 4/6


def test_copied_text_char_shingle_method():
    base = ("Waiting for the handcart vendor who comes late and the county has not responded. "
            "Our landlord promised to fix things in August but nothing happened.")
    subs = [sub("a", text=base), sub("b", text=base.replace("August", "March"), minutes=90)]
    r = result(subs, "a", "copied_text", Params.from_config(copy_method="char_shingle"))
    assert r.fired and r.evidence["method"] == "char_shingle"
    assert r.evidence["best_match"]["similarity"] == 0.885


# straight_lining --------------------------------------------------------------

def test_straight_lining():
    assert result([sub("a", satisfaction=[3] * 8)], "a", "straight_lining").fired
    assert not result([sub("a", satisfaction=[3] * 7 + [4])], "a", "straight_lining").fired
    assert not result([sub("a", satisfaction=[3] * 7)], "a", "straight_lining").fired


# voice_vs_form ----------------------------------------------------------------

def test_voice_vs_form_mismatch_and_match():
    voice = "We buy from the vendor with the handcart, 30 shillings a jerrican."
    mismatch = result([sub("a", source="piped_home", voice=voice)], "a", "voice_vs_form")
    assert mismatch.fired
    assert mismatch.evidence["voice_source"] == "vendor" and mismatch.evidence["form_source"] == "piped_home"
    assert not result([sub("a", source="vendor", voice=voice)], "a", "voice_vs_form").fired


def test_voice_vs_form_without_keyword_stays_quiet():
    r = result([sub("a", source="river", voice="We manage somehow.")], "a", "voice_vs_form")
    assert not r.fired and r.evidence["voice_source"] is None


def test_voice_vs_form_first_keyword_wins():
    voice = "Sometimes the vendor, but mostly the public tap."
    assert result([sub("a", source="public_tap", voice=voice)], "a", "voice_vs_form").fired
    assert not result([sub("a", source="vendor", voice=voice)], "a", "voice_vs_form").fired


# off_hours --------------------------------------------------------------------

@pytest.mark.parametrize("hh,mm,ss,fired", [
    (20, 59, 59, False), (21, 0, 0, True), (5, 59, 59, True), (6, 0, 0, False), (13, 0, 0, False),
])
def test_off_hours_boundaries(hh, mm, ss, fired):
    at = BASE.replace(hour=hh, minute=mm, second=ss)
    assert result([sub("a", at=at)], "a", "off_hours").fired is fired


def test_off_hours_ignores_synced_at():
    daytime = BASE.replace(hour=14)
    r = result([sub("a", at=daytime, synced=daytime.replace(hour=23, minute=30))], "a", "off_hours")
    assert not r.fired


def test_off_hours_uses_project_timezone():
    at = datetime(2026, 10, 27, 18, 30, tzinfo=timezone.utc)  # 21:30 in Nairobi
    assert result([sub("a", at=at)], "a", "off_hours").fired
    assert not result([sub("a", at=at)], "a", "off_hours", Params.from_config(timezone="UTC")).fired


# shared_device ----------------------------------------------------------------

def test_shared_device():
    subs = [sub("a", PART, device="d1"), sub("b", PART2, device="d1", minutes=30), sub("c", PART2, device="d1", minutes=200)]
    r = result(subs, "a", "shared_device")
    assert r.fired
    assert [(a["code"], a["submissions"]) for a in r.evidence["accounts"]] == [("P01", 1), ("P02", 2)]
    assert not result([sub("a", PART, device="d1")], "a", "shared_device").fired


# burst ------------------------------------------------------------------------

def test_burst_participant_needs_five():
    five = [sub(f"p{i}", PART, minutes=10 * i, duration=300) for i in range(5)]
    assert result(five, "p0", "burst").fired
    four = five[:4]
    assert not result(four, "p0", "burst").fired


def test_burst_enumerator_needs_four():
    four = [sub(f"e{i}", minutes=15 * i, duration=600) for i in range(4)]
    r = result(four, "e3", "burst")
    assert r.fired and r.evidence["max_in_window"] == 4


def test_burst_window_boundary():
    exact = [sub(f"p{i}", PART, minutes=15 * i, duration=300) for i in range(5)]  # spans exactly 60:00
    assert result(exact, "p0", "burst").fired and result(exact, "p4", "burst").fired
    over = exact[:4] + [sub("p4", PART, at=BASE + timedelta(minutes=60, seconds=1), duration=300)]
    assert not result(over, "p0", "burst").fired and not result(over, "p4", "burst").fired


# scoring and params -----------------------------------------------------------

def test_score_sums_fired_weights_and_flags_at_threshold():
    only_fast = results([sub("a", duration=600)])["a"]
    assert only_fast.score == 2.0 and only_fast.flagged  # exactly at the review threshold
    only_straight = results([sub("a", satisfaction=[4] * 8)])["a"]
    assert only_straight.score == 1.5 and not only_straight.flagged
    assert [r.key for r in only_fast.results] == list(CHECK_KEYS)


def test_params_merge_over_defaults():
    params = Params.from_config({"weights": {"burst": 4}, "review_threshold": 3}, timezone="UTC")
    assert params.weights["burst"] == 4 and params.weights["too_fast"] == 2.0
    assert params.review_threshold == 3 and params.timezone == "UTC"
    assert "timezone" not in params.to_config()
    assert Params.from_config(Params().to_config()) == Params()
    with pytest.raises(ValueError):
        Params.from_config({"speed_min_minutes": 12})
    with pytest.raises(ValueError):
        Params.from_config({"weights": {"teleport": 1}})
    with pytest.raises(ValueError):
        Params.from_config(copy_method="vibes")


# whole-wave behaviour -----------------------------------------------------------

@pytest.fixture(scope="module")
def wave_inputs():
    from datagen import build_wave, db_rows

    rows = db_rows(build_wave(20261031))
    contributors = [Contributor.from_row(r) for r in rows["contributors"]]
    by_id = {c.id: c for c in contributors}
    # Every planted fraud actor plus genuine neighbours: Manyatta B, E07, E19, E22 and P02.
    keep = {c.id for c in contributors if c.code in {"E07", "E19", "E22", "P02"}}
    keep |= {r["id"] for r in rows["contributors"] if r["area_id"] == rows["areas"][2]["id"]}
    subs = [Submission.from_row(r) for r in rows["submissions"] if r["contributor_id"] in keep]
    return subs, by_id


def test_incremental_matches_batch(wave_inputs):
    subs, contributors = wave_inputs
    params = Params()
    state, existing = {}, []
    for new in sorted(subs, key=lambda s: (s.synced_at, s.id)):
        out = score_incremental(new, existing, contributors, params)
        assert out[0].submission_id == new.id
        for scored in out:
            state[scored.submission_id] = scored
        existing.append(new)
    batch = {s.submission_id: s for s in score_all(subs, contributors, params)}
    assert state == batch
    assert any(s.flagged for s in batch.values())


def test_scoring_is_deterministic_and_order_independent(wave_inputs):
    subs, contributors = wave_inputs
    first = score_all(subs, contributors, Params())
    shuffled = list(subs)
    random.Random(7).shuffle(shuffled)
    assert score_all(subs, contributors, Params()) == first
    assert score_all(shuffled, contributors, Params()) == first


def test_every_result_carries_engine_version(wave_inputs):
    import engine

    subs, contributors = wave_inputs
    assert {s.engine_version for s in score_all(subs, contributors, Params())} == {engine.__version__}


# isolation --------------------------------------------------------------------

def test_engine_imports_only_the_standard_library():
    for path in (ROOT / "engine").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                if node.level:  # relative import inside engine
                    continue
                modules = [node.module or ""]
            else:
                continue
            for module in modules:
                assert module.split(".")[0] in sys.stdlib_module_names, (path, module)

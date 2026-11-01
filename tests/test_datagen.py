import ast
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from matplotlib.path import Path as PolygonPath

from datagen import build_wave, db_rows
from datagen import config as cfg
from datagen import geo

ROOT = Path(__file__).resolve().parent.parent
SEED = 20261031
NOISE_TAGS = {
    "short_genuine", "straightline_genuine", "two_source_transcript",
    "compound_cluster", "late_capture", "late_sync",
}

# Inclusive bounds per fraud type. Curbstone, night, multi_account and burst are
# bounded by construction; the rest are binomial draws with wide margins.
EXPECTED_FRAUD = {
    "curbstone": (12, 24),
    "speeder": (12, 34),
    "copypaste": (6, 30),
    "contradiction": (6, 32),
    "night": (9, 12),
    "multi_account": (12, 36),
    "burst": (23, 27),
}


@pytest.fixture(scope="module")
def wave():
    return build_wave(SEED)


@pytest.fixture(scope="module")
def rows(wave):
    return db_rows(wave)


def _dt(value: str) -> datetime:
    return datetime.fromisoformat(value)


# Determinism ------------------------------------------------------------------

def test_same_seed_gives_identical_rows(rows):
    assert db_rows(build_wave(SEED)) == rows


def test_different_seed_gives_different_rows(rows):
    other = db_rows(build_wave(SEED + 1))
    assert other["projects"][0]["id"] != rows["projects"][0]["id"]
    assert {s["id"] for s in other["submissions"]}.isdisjoint(s["id"] for s in rows["submissions"])
    assert [s["answers"] for s in other["submissions"]] != [s["answers"] for s in rows["submissions"]]


# Geography --------------------------------------------------------------------

def test_every_point_lies_inside_its_contributors_area(rows):
    # matplotlib's polygon test is independent of datagen.geo.
    polygons = {a["id"]: PolygonPath(a["boundary"]["coordinates"][0]) for a in rows["areas"]}
    area_of = {c["id"]: c["area_id"] for c in rows["contributors"]}
    outside = [
        s["id"] for s in rows["submissions"]
        if not polygons[area_of[s["contributor_id"]]].contains_point((s["lng"], s["lat"]))
    ]
    assert outside == []


def test_areas_are_closed_counter_clockwise_rings(rows):
    assert [a["name"] for a in rows["areas"]] == [spec.name for spec in cfg.AREAS]
    for area in rows["areas"]:
        ring = area["boundary"]["coordinates"][0]
        assert ring[0] == ring[-1]
        signed_area = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:]))
        assert signed_area > 0


# Row sanity -------------------------------------------------------------------

def test_capture_never_after_sync_and_durations_positive(rows):
    for s in rows["submissions"]:
        assert _dt(s["captured_at"]) <= _dt(s["synced_at"]), s["id"]
        assert s["duration_sec"] > 0, s["id"]


def test_answers_are_well_formed(rows):
    for s in rows["submissions"]:
        answers = s["answers"]
        assert answers["water_source"] in cfg.WATER_SOURCES
        assert len(answers["satisfaction"]) == 8
        assert all(isinstance(v, int) and 1 <= v <= 5 for v in answers["satisfaction"])
        assert answers["open_text"].strip()
        assert s["voice_transcript"].strip() and s["transcript_lang"] == "en"


def test_ids_unique_and_truth_covers_every_submission(rows):
    ids = [s["id"] for s in rows["submissions"]]
    assert len(set(ids)) == len(ids)
    assert len({s["client_submission_id"] for s in rows["submissions"]}) == len(ids)
    assert [t["submission_id"] for t in rows["synthetic_truth"]] == ids


def test_contributor_mix(rows):
    kinds = Counter(c["kind"] for c in rows["contributors"])
    assert kinds == {"enumerator": 30, "participant": 60}
    codes = {c["code"] for c in rows["contributors"]}
    assert {f"E{n:02d}" for n in range(1, 31)} <= codes


# Planted fraud ----------------------------------------------------------------

@pytest.mark.parametrize("seed", [SEED, 1, 7, 42, 2025])
def test_fraud_counts_and_share_in_range(seed):
    wave = build_wave(seed)
    counts = Counter(s.fraud_type for s in wave.submissions if s.is_fabricated)
    for fraud_type, (low, high) in EXPECTED_FRAUD.items():
        assert low <= counts[fraud_type] <= high, (fraud_type, counts[fraud_type])
    share = sum(counts.values()) / len(wave.submissions)
    assert 0.05 <= share <= 0.12


def test_fraud_has_the_planted_shape(wave):
    subs = wave.submissions
    eat_hour = lambda s: s.captured_at.astimezone(cfg.EAT).hour  # noqa: E731

    tea = [s.point for s in subs if s.fraud_type == "curbstone"]
    centre = (sum(p[0] for p in tea) / len(tea), sum(p[1] for p in tea) / len(tea))
    assert max(geo.distance_m(centre, p) for p in tea) <= 24
    assert all(s.contributor.code == cfg.CURBSTONE for s in subs if s.fraud_type == "curbstone")

    assert all(240 <= s.duration_sec <= 540 for s in subs if s.fraud_type == "speeder")
    assert all(eat_hour(s) in (22, 23, 0) for s in subs if s.fraud_type == "night")

    burst = sorted((s for s in subs if s.fraud_type == "burst"), key=lambda s: s.captured_at)
    assert burst[-1].captured_at - burst[0].captured_at <= timedelta(minutes=75)

    ring = [s for s in subs if s.fraud_type == "multi_account"]
    assert {s.device_id for s in ring} == {wave.ring_device}
    assert {s.contributor.code for s in ring} == set(wave.ring_members) and len(wave.ring_members) == 4


def test_genuine_noise_stays_genuine(wave, rows):
    noisy = [s for s in wave.submissions if s.noise_tag]
    assert noisy and not any(s.is_fabricated for s in noisy)
    assert {t["noise_tag"] for t in rows["synthetic_truth"]} == {None, *NOISE_TAGS}

    genuine = [s for s in wave.submissions if not s.is_fabricated]
    interviews = [s for s in genuine if s.contributor.kind == "enumerator"]
    short = [s for s in genuine if s.noise_tag == "short_genuine"]
    straight = [s for s in genuine if s.noise_tag == "straightline_genuine"]
    two_source = [s for s in genuine if s.noise_tag == "two_source_transcript"]
    assert 0.008 <= len(short) / len(interviews) <= 0.012
    assert all(s.contributor.kind == "enumerator" and s.duration_sec < 12 * 60 for s in short)
    assert 0.003 <= len(straight) / len(genuine) <= 0.007
    # The planted rows are the only genuine straight-liners.
    assert [s for s in genuine if len(set(s.answers["satisfaction"])) == 1] == straight
    assert 0.003 <= len(two_source) / len(genuine) <= 0.007

    for s in wave.submissions:
        if s.noise_tag == "late_sync":
            # Synced the next day or later, but captured in daytime: not night work.
            assert 7 <= s.captured_at.astimezone(cfg.EAT).hour <= 21
            assert s.synced_at.astimezone(cfg.EAT).date() > s.captured_at.astimezone(cfg.EAT).date()


# Isolation --------------------------------------------------------------------

def test_engine_does_not_import_datagen():
    for path in (ROOT / "engine").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                modules = [node.module or ""]
            else:
                continue
            assert not any(m == "datagen" or m.startswith("datagen.") for m in modules), path
    check = subprocess.run(
        [sys.executable, "-c", "import sys, engine; print('datagen' in sys.modules)"],
        cwd=ROOT, capture_output=True, text=True, check=True,
    )
    assert check.stdout.strip() == "False"


def test_detection_code_never_mentions_the_truth_table():
    # The engine never sees ground truth. In the API only the /evaluate path reads
    # it (server-side, aggregates out): the repo query and api/_lib/evaluation.py.
    allowed = {ROOT / "api" / "_lib" / "repo.py", ROOT / "api" / "_lib" / "evaluation.py"}
    for path in [*(ROOT / "engine").rglob("*.py"), *(ROOT / "api").rglob("*.py")]:
        if path not in allowed:
            assert "synthetic_truth" not in path.read_text(), path
    assert "truth_labels" not in (ROOT / "api" / "_lib" / "service.py").read_text()


# Live day ---------------------------------------------------------------------

@pytest.fixture(scope="module")
def live(wave):
    from datagen.live import build_live_day

    return build_live_day(SEED, wave)


def test_live_day_is_deterministic_and_separate(live, wave):
    from datagen.live import LIVE_DAY, build_live_day

    again = build_live_day(SEED)
    assert [(s.id, s.client_submission_id, s.answers) for s in again.submissions] == \
           [(s.id, s.client_submission_id, s.answers) for s in live.submissions]
    assert 250 <= len(live.submissions) <= 300
    assert {s.captured_at.astimezone(cfg.EAT).date() for s in live.submissions if s.fraud_type != "night"} == {LIVE_DAY}
    base_ids = {s.client_submission_id for s in wave.submissions}
    assert base_ids.isdisjoint(s.client_submission_id for s in live.submissions)


def test_live_day_continues_every_fraud_actor(live, wave):
    by_type = Counter(s.fraud_type for s in live.submissions if s.is_fabricated)
    assert set(by_type) == set(cfg.FRAUD_TYPES)
    assert {s.contributor.code for s in live.submissions if s.fraud_type == "curbstone"} == {cfg.CURBSTONE}
    assert {s.device_id for s in live.submissions if s.fraud_type == "multi_account"} == {wave.ring_device}
    assert {s.contributor.code for s in live.submissions if s.fraud_type == "burst"} == {wave.burst_account}
    # Same tea shop as during the wave.
    tea = [s.point for s in wave.submissions if s.fraud_type == "curbstone"]
    centre = (sum(p[0] for p in tea) / len(tea), sum(p[1] for p in tea) / len(tea))
    assert all(geo.distance_m(centre, s.point) <= 24 for s in live.submissions if s.fraud_type == "curbstone")


def test_live_day_rows_are_sane(live):
    for s in live.submissions:
        assert geo.contains(s.contributor.area.ring, s.point)
        assert s.captured_at <= s.synced_at and s.duration_sec > 0
        assert s.noise_tag is None or not s.is_fabricated
    assert [s.synced_at for s in live.submissions] == sorted(s.synced_at for s in live.submissions)

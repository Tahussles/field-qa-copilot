import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from api._lib import service
from api._lib.repo import InMemoryRepo
from api._lib.schemas import SubmissionIn
from api.index import app, get_repo, passcode_value
from engine import CHECK_KEYS, Contributor, Params, Submission, score_all
from tests.test_engine import LNG, north

PASSCODE = "test-passcode"
AUTH = {"X-Demo-Passcode": PASSCODE}
EAT = timezone(timedelta(hours=3))
DAY = datetime(2026, 10, 27, tzinfo=EAT)
PROJECT = {"id": "11111111-1111-4111-8111-111111111111", "name": "Test survey", "region": "Kisumu, Kenya",
           "timezone": "Africa/Nairobi"}
AREAS = [{"id": "area-1", "name": "Kondele"}]
CONTRIBUTORS = [
    {"id": "c-e01", "code": "E01", "display_name": "Mercy O.", "kind": "enumerator", "area_id": "area-1"},
    {"id": "c-p01", "code": "P01", "display_name": "Brian A.", "kind": "participant", "area_id": "area-1"},
    {"id": "c-p02", "code": "P02", "display_name": "Faith W.", "kind": "participant", "area_id": "area-1"},
]


def make_repo(**kwargs) -> InMemoryRepo:
    return InMemoryRepo(PROJECT, CONTRIBUTORS, AREAS, Params().to_config(), **kwargs)


@pytest.fixture
def repo():
    return make_repo()


@pytest.fixture
def client(repo):
    app.dependency_overrides[get_repo] = lambda: repo
    app.dependency_overrides[passcode_value] = lambda: PASSCODE
    yield TestClient(app)
    app.dependency_overrides.clear()


def payload(code="E01", *, hour=10.0, duration=1800, north_m=None, device=None, client_id=None,
            satisfaction=None) -> dict:
    return {
        "contributor_code": code,
        "device_id": device or f"device-{code}",
        "client_submission_id": client_id or f"client-{uuid.uuid4()}",
        "captured_at": (DAY + timedelta(hours=hour)).isoformat(),
        "duration_sec": duration,
        "lat": north(uuid.uuid4().int % 50_000 + 1_000 if north_m is None else north_m),
        "lng": LNG,
        "gps_accuracy_m": 8.0,
        "answers": {"water_source": "public_tap", "satisfaction": satisfaction or [1, 2, 3, 4, 5, 1, 2, 3],
                    "open_text": f"answer {uuid.uuid4().hex}"},
        "voice_transcript": "We fetch from the public tap near the market.",
        "source": "simulator",
    }


def post(client, body):
    return client.post("/api/py/submissions", json=body, headers=AUTH)


# POST /submissions ------------------------------------------------------------------

def test_retry_with_same_client_id_is_idempotent(client, repo):
    body = payload()
    first, second = post(client, body), post(client, body)
    assert (first.status_code, second.status_code) == (201, 200)
    assert second.json()["id"] == first.json()["id"] and second.json()["duplicate"] is True
    assert second.json()["score"] == first.json()["score"]
    assert len(repo.submissions()) == 1


@pytest.mark.parametrize("change", [
    {"lat": "not-a-number"},
    {"lng": "34.79"},
    {"duration_sec": 12.5},
    {"answers": None},
    {"source": "synthetic"},
    {"captured_at": (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()},
    {"captured_at": "2026-10-27T10:00:00"},  # no UTC offset
])
def test_invalid_bodies_are_rejected(client, change):
    body = payload()
    body.update(change)
    if change.get("answers", 1) is None:
        del body["answers"]
    assert post(client, body).status_code == 422


def test_bad_satisfaction_and_unknown_contributor(client):
    assert post(client, payload(satisfaction=[1, 2, 3, 4, 5, 6, 1, 2])).status_code == 422
    assert post(client, payload(code="E99")).status_code == 422


def test_writes_need_the_passcode(client):
    body = payload()
    assert client.post("/api/py/submissions", json=body).status_code == 401
    assert client.post("/api/py/submissions", json=body, headers={"X-Demo-Passcode": "nope"}).status_code == 401
    assert client.post("/api/py/rescore").status_code == 401
    assert client.post("/api/py/reviews", json={"submission_id": str(uuid.uuid4()), "decision": "approve"}).status_code == 401
    assert client.get("/api/py/queue").status_code == 200  # reads are public


def test_third_same_spot_arrival_flips_earlier_ones(client):
    # Two evening interviews at one spot: off_hours only, so watch band.
    first = post(client, payload(hour=21 + 10 / 60, north_m=0)).json()
    second = post(client, payload(hour=21 + 40 / 60, north_m=8)).json()
    assert (first["band"], second["band"]) == ("watch", "watch")
    assert second["changed"] == []

    # A short third interview at the same spot makes same_spot fire for all three.
    third = post(client, payload(hour=22 + 10 / 60, north_m=4, duration=600)).json()
    assert third["flagged"] is True
    assert {f["key"] for f in third["fired"]} == {"same_spot", "too_fast", "off_hours"}
    flips = {c["submission_id"]: c for c in third["changed"]}
    assert set(flips) == {first["id"], second["id"]}
    assert all(c["flagged"] is True and c["previously_flagged"] is False and c["score"] == 2.5 for c in flips.values())


# Queue and reviews ----------------------------------------------------------------------

def _seed_queue(client):
    ids = {}
    ids["a"] = post(client, payload(hour=21 + 10 / 60, north_m=0)).json()["id"]
    ids["b"] = post(client, payload(hour=21 + 40 / 60, north_m=8)).json()["id"]
    ids["c"] = post(client, payload(hour=22 + 10 / 60, north_m=4, duration=600)).json()["id"]  # 4.5
    ids["p1"] = post(client, payload("P01", hour=9, duration=100)).json()["id"]  # too_fast: 2.0
    ids["p2"] = post(client, payload("P02", hour=9, satisfaction=[3] * 8)).json()["id"]  # straight-lined: 1.5
    return ids


def test_queue_orders_by_score_and_filters_by_band(client):
    ids = _seed_queue(client)
    flagged = client.get("/api/py/queue").json()
    assert [i["submission_id"] for i in flagged["items"]] == [ids["c"], ids["a"], ids["b"], ids["p1"]]
    assert [i["score"] for i in flagged["items"]] == [4.5, 2.5, 2.5, 2.0]
    watch = client.get("/api/py/queue", params={"band": "watch"}).json()
    assert [i["submission_id"] for i in watch["items"]] == [ids["p2"]]
    only_e01 = client.get("/api/py/queue", params={"contributor": "E01", "limit": 2}).json()
    assert only_e01["total"] == 3 and len(only_e01["items"]) == 2


def test_review_create_conflict_and_undo(client):
    ids = _seed_queue(client)
    review = client.post("/api/py/reviews", json={"submission_id": ids["c"], "decision": "backcheck", "note": "visit"},
                         headers=AUTH)
    assert review.status_code == 201
    again = client.post("/api/py/reviews", json={"submission_id": ids["c"], "decision": "reject"}, headers=AUTH)
    assert again.status_code == 409
    decided = client.get("/api/py/queue", params={"status": "decided"}).json()["items"]
    assert [i["submission_id"] for i in decided] == [ids["c"]] and decided[0]["review"]["decision"] == "backcheck"
    assert ids["c"] not in [i["submission_id"] for i in client.get("/api/py/queue").json()["items"]]

    undo = client.delete(f"/api/py/reviews/{review.json()['id']}", headers=AUTH)
    assert undo.status_code == 200 and undo.json()["revoked_at"] is not None
    assert client.delete(f"/api/py/reviews/{review.json()['id']}", headers=AUTH).status_code == 404
    assert client.post("/api/py/reviews", json={"submission_id": ids["c"], "decision": "reject"},
                       headers=AUTH).status_code == 201
    assert client.post("/api/py/reviews", json={"submission_id": str(uuid.uuid4()), "decision": "approve"},
                       headers=AUTH).status_code == 404


def test_submission_detail(client):
    ids = _seed_queue(client)
    client.post("/api/py/reviews", json={"submission_id": ids["c"], "decision": "reject"}, headers=AUTH)
    detail = client.get(f"/api/py/submissions/{ids['c']}").json()
    assert [c["key"] for c in detail["checks"]] == sorted(CHECK_KEYS)
    assert detail["score"]["band"] == "flagged" and detail["contributor"]["code"] == "E01"
    assert detail["review"]["decision"] == "reject"
    assert client.get(f"/api/py/submissions/{uuid.uuid4()}").status_code == 404
    assert client.get("/api/py/submissions/not-a-uuid").status_code == 422


def test_overview(client):
    _seed_queue(client)
    data = client.get("/api/py/overview", params={"date": "2026-10-27"}).json()
    assert data["kpis"] == {"received": 5, "flagged": 4, "watch": 1, "pending_review": 4,
                            "contributors_to_investigate": 1}
    assert data["yesterday"]["date"] == "2026-10-27" and data["yesterday"]["flagged"] == 4
    assert data["contributors"][0]["code"] == "E01" and data["areas"][0]["area"] == "Kondele"
    assert data["hotspots"] == []  # three same-spot interviews are below the hotspot minimum of four


def test_rescore(client):
    _seed_queue(client)
    result = client.post("/api/py/rescore", headers=AUTH).json()
    assert result["submissions"] == 5 and result["flagged"] == 4 and result["check_results"] == 40


# POST /evaluate ----------------------------------------------------------------------

def test_evaluate_returns_aggregates_only():
    from datagen import build_wave, db_rows

    rows = db_rows(build_wave(1))
    repo = InMemoryRepo(rows["projects"][0], rows["contributors"], rows["areas"], rows["check_config"][0]["params"],
                        submissions=rows["submissions"], truth=rows["synthetic_truth"])
    app.dependency_overrides[get_repo] = lambda: repo
    try:
        client = TestClient(app)
        response = client.post("/api/py/evaluate", json={"params": {"weights": {"same_spot": 3}}})
        assert response.status_code == 200
        data = response.json()
        assert set(data["per_check"]) == set(CHECK_KEYS)
        assert data["params"]["weights"]["same_spot"] == 3 and data["params"]["weights"]["burst"] == 2.5
        assert 0 < data["combined"]["precision"] < 1 and data["combined"]["submissions"] == len(rows["submissions"])
        text = response.text
        assert "submission_id" not in text
        leaked = [s["id"] for s in rows["submissions"] if s["id"] in text]
        leaked += [s["client_submission_id"] for s in rows["submissions"] if s["client_submission_id"] in text]
        assert leaked == []
        assert client.post("/api/py/evaluate", json={"params": {"teleport": 1}}).status_code == 422
    finally:
        app.dependency_overrides.clear()


# Concurrency ---------------------------------------------------------------------------

def test_concurrent_arrivals_end_up_like_a_batch():
    repo = make_repo(write_delay=0.02)  # slow writes widen the race window
    bodies = [payload(hour=10 + i * 0.2, north_m=3 * i, duration=700) for i in range(6)]
    bodies += [payload("P01", hour=11, device="shared"), payload("P02", hour=11.1, device="shared")]
    with ThreadPoolExecutor(max_workers=len(bodies)) as pool:
        statuses = list(pool.map(lambda b: service.ingest(repo, SubmissionIn(**b))[0], bodies))
    assert statuses == [201] * len(bodies)

    contributors = {c["id"]: Contributor.from_row(c) for c in CONTRIBUTORS}
    batch = score_all([Submission.from_row(r) for r in repo.submissions()], contributors, Params())
    stored = {s["submission_id"]: (s["score"], s["flagged"]) for s in repo.scores()}
    assert stored == {s.submission_id: (s.score, s.flagged) for s in batch}
    for s in batch:
        assert {(r["check_key"], r["fired"], json.dumps(r["evidence"], sort_keys=True))
                for r in repo.check_results(s.submission_id)} == {
            (r.key, r.fired, json.dumps(r.evidence, sort_keys=True)) for r in s.results}

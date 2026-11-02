"""Demo controls: /demo/reset, /demo/step and /demo/status against the seeded wave and live day."""

import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from api._lib import demo
from api._lib.repo import InMemoryRepo
from api.index import app, get_repo, passcode_value
from datagen import build_wave, db_rows
from datagen import config as cfg
from datagen.live import api_payload, build_live_day
from engine import Contributor, Params, Submission, score_all

PASSCODE = "test-passcode"
AUTH = {"X-Demo-Passcode": PASSCODE}
SEED = demo.DEMO_SEED


@pytest.fixture(scope="module")
def wave():
    return build_wave(SEED)


@pytest.fixture(scope="module")
def live(wave):
    return build_live_day(SEED, wave)


def fresh_repo(wave) -> InMemoryRepo:
    """The state after generate.py --reset and score.py: the wave, batch-scored."""
    rows = db_rows(wave)
    repo = InMemoryRepo(rows["projects"][0], rows["contributors"], rows["areas"], rows["check_config"][0]["params"],
                        submissions=rows["submissions"], truth=rows["synthetic_truth"])
    repo.set_demo_run(str(uuid.uuid4()))
    with client_for(repo) as client:
        assert client.post("/api/py/rescore", headers=AUTH).status_code == 200
    return repo


class client_for:
    def __init__(self, repo):
        self.repo = repo

    def __enter__(self) -> TestClient:
        app.dependency_overrides[get_repo] = lambda: self.repo
        app.dependency_overrides[passcode_value] = lambda: PASSCODE
        return TestClient(app)

    def __exit__(self, *exc):
        app.dependency_overrides.clear()


def state(repo: InMemoryRepo) -> dict:
    """Everything a reset must restore, keyed by submission id."""
    subs = repo.submissions()
    return {
        "submissions": {r["id"]: r["client_submission_id"] for r in subs},
        "scores": {s["submission_id"]: (s["score"], s["flagged"], s["engine_version"]) for s in repo.scores()},
        "checks": {r["id"]: {c["check_key"]: (c["fired"], c["weight"], c["evidence"]) for c in repo.check_results(r["id"])}
                   for r in subs},
        "reviews": repo.reviews(),
        "as_of": repo.clock()["as_of"],
    }


def by_client_id(repo: InMemoryRepo) -> dict:
    ids = {r["id"]: r["client_submission_id"] for r in repo.submissions()}
    fired = {}
    for r in repo.fired_checks(repo.scores()[0]["engine_version"]):
        fired.setdefault(ids[r["submission_id"]], set()).add(r["check_key"])
    return {ids[s["submission_id"]]: (s["score"], s["flagged"], frozenset(fired.get(ids[s["submission_id"]], ())))
            for s in repo.scores()}


def step(client, repo, **body):
    return client.post("/api/py/demo/step", json={"run_id": repo.clock()["demo_run_id"], **body}, headers=AUTH)


def run_live_day(client, repo) -> int:
    calls = 0
    while True:
        body = step(client, repo, count=50).json()
        calls += 1
        if body["progress"]["done"]:
            return calls


def test_demo_endpoints_need_the_passcode(wave):
    with client_for(fresh_repo(wave)) as client:
        assert client.get("/api/py/demo/status").status_code == 401
        assert client.post("/api/py/demo/step", json={"run_id": str(uuid.uuid4())}).status_code == 401
        assert client.post("/api/py/demo/reset", headers={"X-Demo-Passcode": "wrong"}).status_code == 401


def test_key_moments_come_from_the_live_day_fraud_actors(wave, live):
    with client_for(fresh_repo(wave)) as client:
        data = client.get("/api/py/demo/status", headers=AUTH).json()
    moments = {m["key"]: m for m in data["moments"]}
    assert set(moments) == set(cfg.FRAUD_TYPES)
    assert [m["field_time"] for m in data["moments"]] == sorted(m["field_time"] for m in data["moments"])
    assert moments["curbstone"]["codes"] == [cfg.CURBSTONE] and moments["curbstone"]["label"] == "E07 tea-shop batch"
    assert moments["burst"]["codes"] == [wave.burst_account]
    assert moments["multi_account"]["codes"] == sorted(wave.ring_members)
    assert moments["multi_account"]["label"] == "Ring device activity"
    for key, code in (("night", cfg.NIGHT), ("contradiction", cfg.CONTRADICTION), ("copypaste", cfg.COPYPASTE),
                      ("speeder", cfg.SPEEDER)):
        assert moments[key]["codes"] == [code]
    by_client = {s.client_submission_id: s for s in live.submissions}
    for key, m in moments.items():
        opener = by_client[m["client_submission_id"]]
        first_fake = next(s for s in live.submissions if s.fraud_type == key)
        # The moment opens the sync batch that carries the actor's first fake, never after it.
        assert opener.synced_at.isoformat() <= first_fake.synced_at.isoformat()
        assert demo._iso(opener.synced_at) == m["field_time"] and m["sent"] is False
    assert data["progress"] == {"sent": 0, "total": len(live.submissions), "flagged": 0,
                                "field_clock": cfg.PROJECT_AS_OF, "done": False,
                                "next_field_time": demo._iso(live.submissions[0].synced_at)}


def test_step_is_idempotent_and_moves_the_clock(wave, live):
    repo = fresh_repo(wave)
    until = live.submissions[11].synced_at.isoformat()
    with client_for(repo) as client:
        first = step(client, repo, until_field_time=until).json()
        again = step(client, repo, until_field_time=until).json()
    assert len(first["results"]) == 12 and again["results"] == []
    assert first["progress"]["sent"] == again["progress"]["sent"] == 12
    assert len(repo.submissions(source="simulator")) == 12
    assert repo.clock()["as_of"] == demo._iso(live.submissions[11].synced_at)
    assert first["progress"]["next_field_time"] == demo._iso(live.submissions[12].synced_at)
    sent = {r["id"] for r in first["results"]}
    assert set(repo._truth) >= sent  # labels written server-side for exactly what was sent
    assert {r["code"] for r in first["results"]} == {s.contributor.code for s in live.submissions[:12]}


def test_concurrent_steps_never_send_twice(wave, live):
    repo = fresh_repo(wave)
    with client_for(repo) as client:
        with ThreadPoolExecutor(max_workers=4) as pool:
            bodies = list(pool.map(lambda _: step(client, repo, count=8).json(), range(4)))
        status = client.get("/api/py/demo/status", headers=AUTH).json()
    stored = [r["client_submission_id"] for r in repo.submissions(source="simulator")]
    assert len(stored) == len(set(stored)) == status["progress"]["sent"]
    # Two tabs racing on the same pending items: the loser's ingest is a duplicate, not a second row.
    sent = [r for b in bodies for r in b["results"]]
    assert {r["id"] for r in sent} == {r["id"] for r in repo.submissions(source="simulator")}
    assert stored and set(stored) <= {s.client_submission_id for s in live.submissions[:32]}


def test_steps_end_like_the_cli_simulator(wave, live):
    """The full live day by /demo/step ends with the same scores as simulate.py posting every payload."""
    by_step = fresh_repo(wave)
    with client_for(by_step) as client:
        calls = run_live_day(client, by_step)
    by_simulator = fresh_repo(wave)
    with client_for(by_simulator) as client:
        for sub in live.submissions:
            assert client.post("/api/py/submissions", json=api_payload(sub), headers=AUTH).status_code == 201
    assert calls == -(-len(live.submissions) // 50)
    assert by_client_id(by_step) == by_client_id(by_simulator)
    # And both equal a fresh batch scoring of wave + live day.
    contributors = {c["id"]: Contributor.from_row(c) for c in by_step.contributors()}
    batch = score_all([Submission.from_row(r) for r in by_step.submissions()], contributors,
                      Params.from_config(by_step.check_params(), timezone="Africa/Nairobi"))
    assert {s["submission_id"]: (s["score"], s["flagged"]) for s in by_step.scores()} == {
        s.submission_id: (s.score, s.flagged) for s in batch}
    assert by_step.clock()["as_of"] == demo._iso(live.submissions[-1].synced_at)


def test_reset_restores_the_fresh_wave(wave, live):
    repo = fresh_repo(wave)
    fresh = state(repo)
    with client_for(repo) as client:
        run_live_day(client, repo)
        wave_row = next(iter(fresh["submissions"]))
        live_row = repo.submissions(source="simulator")[0]["id"]
        for sid in (wave_row, live_row):
            assert client.post("/api/py/reviews", json={"submission_id": sid, "decision": "reject"},
                               headers=AUTH).status_code == 201
        during = state(repo)["checks"]
        assert any(during[sid] != fresh["checks"][sid] for sid in fresh["checks"])  # the live day touched wave rows
        result = client.post("/api/py/demo/reset", headers=AUTH).json()
    assert state(repo) == fresh
    assert result["deleted"]["submissions"] == len(live.submissions)
    assert result["deleted"]["scores"] == len(live.submissions) and result["deleted"]["reviews"] == 2
    assert result["deleted"]["synthetic_truth"] == len(live.submissions)
    assert result["rescored"]["rows_written"] > 0 and result["as_of"] == cfg.PROJECT_AS_OF
    with client_for(repo) as client:
        again = client.post("/api/py/demo/reset", headers=AUTH).json()
    assert again["deleted"]["submissions"] == 0 and again["rescored"]["rows_written"] == 0


def test_landing_replays_yesterday_with_aggregate_counters(wave):
    with client_for(fresh_repo(wave)) as client:
        response = client.get("/api/py/landing")
    data = response.json()
    assert response.headers["cache-control"].startswith("public")
    assert data["date"] == "2026-10-30" and data["points"]
    assert all(p["captured_at"] >= "2026-10-29T21:00" and p["captured_at"] < "2026-10-30T21:00" for p in data["points"])
    counters = data["counters"]
    assert counters["submissions"] == len(wave.submissions)
    assert counters["fabricated"] == sum(s.is_fabricated for s in wave.submissions)
    assert 0 < counters["precision"] <= 1 and 0 < counters["recall"] <= 1
    assert "fraud_type" not in response.text and "is_fabricated" not in response.text


def test_a_reset_during_a_step_stops_the_step_cleanly(wave, live, monkeypatch):
    """A reset from another tab deletes rows a running step just sent: the step ends without an error
    status, flags it, and leaves the clock where the reset put it."""
    repo = fresh_repo(wave)
    ingest = demo.service.ingest
    calls = []

    def ingest_then_reset(repo_, body):
        out = ingest(repo_, body)
        calls.append(body.client_submission_id)
        if len(calls) == 2:
            demo.reset(repo_)
        return out

    monkeypatch.setattr(demo.service, "ingest", ingest_then_reset)
    with client_for(repo) as client:
        response = step(client, repo, count=4)
    body = response.json()
    assert response.status_code == 200 and "reset" in body["error"]
    assert repo.clock()["as_of"] == cfg.PROJECT_AS_OF
    # What the step sent after the reset is stored with its labels; what the reset removed is gone.
    stored = {r["id"] for r in repo.submissions(source="simulator")}
    assert stored == {r["id"] for r in body["results"][2:]} and set(repo._truth) >= stored


def test_a_reset_issues_a_new_run_and_old_steps_get_409(wave):
    repo = fresh_repo(wave)
    with client_for(repo) as client:
        old = client.get("/api/py/demo/status", headers=AUTH).json()["run_id"]
        assert step(client, repo, count=2).status_code == 200
        new = client.post("/api/py/demo/reset", headers=AUTH).json()["run_id"]
        assert new != old and client.get("/api/py/demo/status", headers=AUTH).json()["run_id"] == new
        stale = client.post("/api/py/demo/step", json={"run_id": old, "count": 2}, headers=AUTH)
        assert stale.status_code == 409 and "reset" in stale.json()["detail"]
        assert repo.submissions(source="simulator") == []
        assert step(client, repo, count=2).status_code == 200


def test_today_stays_pinned_to_the_live_day_after_midnight(wave, live):
    repo = fresh_repo(wave)
    with client_for(repo) as client:
        run_live_day(client, repo)  # the last syncs are the next afternoon
        data = client.get("/api/py/overview").json()
    assert data["now"].startswith("2026-11-01")  # the clock shows real field time
    assert data["today_is_pinned"] and data["today"]["date"] == "2026-10-31"
    assert data["yesterday"]["date"] == "2026-10-30"
    captured_on_live_day = sum(s.captured_at.astimezone(cfg.EAT).date().isoformat() == "2026-10-31"
                               for s in live.submissions)
    assert data["today"]["received"] == captured_on_live_day

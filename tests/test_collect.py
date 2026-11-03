"""The phone collect page's access: collect tokens, phone-shaped writes, voice uploads."""

import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from api._lib import collect
from api._lib.repo import InMemoryRepo
from api.index import app, collect_key, get_repo, passcode_value
from engine import Params
from tests.test_api import AREAS, AUTH, CONTRIBUTORS, PASSCODE, PROJECT, make_repo, payload

KEY = collect.secret("test-service-key")
RUN = str(uuid.uuid4())


def test_tokens_expire_are_revoked_by_a_new_run_and_cannot_be_forged():
    token, expires = collect.mint(KEY, RUN, ttl_seconds=1800, now=1_000_000)
    assert len(token) < 50 and expires == 1_001_800
    assert collect.verify(KEY, token, RUN, now=1_000_100) == expires
    with pytest.raises(collect.Refused, match="expired"):
        collect.verify(KEY, token, RUN, now=1_002_000)
    with pytest.raises(collect.Refused, match="revoked"):
        collect.verify(KEY, token, str(uuid.uuid4()), now=1_000_100)
    forged = token.rsplit(".", 1)[0] + ".AAAAAAAAAAAAAAAAAAAAAA"
    with pytest.raises(collect.Refused, match="not a collect token"):
        collect.verify(KEY, forged, RUN, now=1_000_100)
    longer = f"{expires + 3600:x}." + token.split(".", 1)[1]  # a phone editing its own expiry
    with pytest.raises(collect.Refused):
        collect.verify(KEY, longer, RUN, now=1_000_100)


def test_voice_paths_are_per_phone_and_audio_only():
    assert collect.voice_path("phone-abc123", "client-123456", "audio/webm;codecs=opus") == \
        "live/phone-abc123/client-123456.webm"
    assert collect.voice_path("phone-abc123", "client-123456", "audio/mp4").endswith(".m4a")
    with pytest.raises(ValueError):
        collect.voice_path("phone-abc123", "client-123456", "image/png")
    with pytest.raises(ValueError):
        collect.voice_path("../../etc", "client-123456", "audio/webm")


@pytest.fixture
def repo():
    repo = make_repo()
    repo.set_demo_run(RUN)
    return repo


@pytest.fixture
def client(repo):
    app.dependency_overrides[get_repo] = lambda: repo
    app.dependency_overrides[passcode_value] = lambda: PASSCODE
    app.dependency_overrides[collect_key] = lambda: KEY
    yield TestClient(app)
    app.dependency_overrides.clear()


def phone(token):
    return {"X-Collect-Token": token}


def live(code="E01", device="phone-abc123", **extra):
    body = payload(code, device=device, **extra)
    body["source"] = "live"
    return body


def test_a_token_from_the_panel_opens_the_collect_page_and_nothing_else(client, repo):
    assert client.post("/api/py/collect/token", json={}).status_code == 401
    minted = client.post("/api/py/collect/token", json={}, headers=AUTH).json()
    assert minted["path"] == f"/collect?t={minted['token']}" and minted["expires_at"] > time.time() + 1700
    token = minted["token"]

    assert client.get("/api/py/collect/session").status_code == 401
    session = client.get("/api/py/collect/session", headers=phone(token)).json()
    assert session["expires_at"] == minted["expires_at"] and [c["code"] for c in session["contributors"]][0] == "E01"
    assert client.get("/api/py/collect/session", headers=AUTH).json()["expires_at"] is None  # the passcode works too

    upload = client.post("/api/py/collect/upload", headers=phone(token), json={
        "device_id": "phone-abc123", "client_submission_id": "client-123456", "content_type": "audio/webm;codecs=opus"})
    assert upload.json()["path"] == "live/phone-abc123/client-123456.webm"

    ok = client.post("/api/py/submissions", headers=phone(token),
                     json={**live(), "voice_note_path": "live/phone-abc123/client-123456.webm"})
    assert ok.status_code == 201
    simulated = client.post("/api/py/submissions", headers=phone(token), json={**live(), "source": "simulator"})
    assert simulated.status_code == 403
    elsewhere = client.post("/api/py/submissions", headers=phone(token),
                            json={**live(), "voice_note_path": "live/other-phone/x.webm"})
    assert elsewhere.status_code == 403
    # Writes beyond a phone's still need the passcode.
    assert client.post("/api/py/rescore", headers=phone(token)).status_code == 401


def test_expired_and_revoked_tokens_are_refused(client, repo):
    short = client.post("/api/py/collect/token", json={"ttl_seconds": 1}, headers=AUTH).json()["token"]
    time.sleep(1.2)
    expired = client.get("/api/py/collect/session", headers=phone(short))
    assert expired.status_code == 401 and "expired" in expired.json()["detail"]

    token = client.post("/api/py/collect/token", json={}, headers=AUTH).json()["token"]
    repo.set_demo_run(str(uuid.uuid4()))  # what a demo reset does
    revoked = client.post("/api/py/submissions", headers=phone(token), json=live())
    assert revoked.status_code == 401 and "reset" in revoked.json()["detail"]


def test_switching_contributor_on_one_phone_is_a_shared_device(client):
    token = client.post("/api/py/collect/token", json={}, headers=AUTH).json()["token"]
    first = client.post("/api/py/submissions", headers=phone(token), json=live("P01", hour=9)).json()
    second = client.post("/api/py/submissions", headers=phone(token), json=live("P02", hour=10)).json()
    assert "shared_device" not in [f["key"] for f in first["fired"]]
    shared = next(f for f in second["fired"] if f["key"] == "shared_device")
    assert shared["evidence"]["account_count"] == 2 and {a["code"] for a in shared["evidence"]["accounts"]} == {"P01", "P02"}
    assert any(c["submission_id"] == first["id"] for c in second["changed"])  # the first one flips too


# The field clock ---------------------------------------------------------------------

AS_OF = datetime(2026, 10, 31, 8, 0, tzinfo=timezone(timedelta(hours=3)))  # the demo's 08:00 in Kisumu


def clocked(as_of, set_minutes_ago=10):
    """A demo project whose field clock was set to as_of a few real minutes ago."""
    set_at = datetime.now(timezone.utc) - timedelta(minutes=set_minutes_ago)
    project = {**PROJECT, "as_of": as_of and as_of.isoformat(), "clock_set_at": as_of and set_at.isoformat()}
    repo = InMemoryRepo(project, CONTRIBUTORS, AREAS, Params().to_config())
    repo.set_demo_run(RUN)
    return repo


def send(repo, body):
    app.dependency_overrides[get_repo] = lambda: repo
    app.dependency_overrides[passcode_value] = lambda: PASSCODE
    try:
        response = TestClient(app).post("/api/py/submissions", headers=AUTH, json=body)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 201, response.text
    return response.json()


def at(value: str) -> datetime:
    return datetime.fromisoformat(value)


def test_in_a_demo_a_phone_interview_lands_on_the_field_clock_and_keeps_its_own_time():
    repo = clocked(AS_OF, set_minutes_ago=10)
    phone_time = datetime.now(timezone.utc) - timedelta(minutes=2)  # whatever hour it is where the phone is
    body = send(repo, {**live(), "captured_at": phone_time.isoformat()})
    # 8 real minutes after the clock was set: 08:08 in Kisumu, whatever the phone's own time zone says.
    assert abs(at(body["captured_at"]) - (AS_OF + timedelta(minutes=8))) < timedelta(seconds=5)
    assert at(body["device_captured_at"]) == phone_time
    assert abs(at(body["synced_at"]) - (AS_OF + timedelta(minutes=10))) < timedelta(seconds=5)
    assert "off_hours" not in [f["key"] for f in body["fired"]]
    stored = repo.submission(body["id"])
    assert stored["captured_at"] == body["captured_at"] and stored["device_captured_at"] == body["device_captured_at"]


def test_a_phone_clock_ahead_of_the_server_lands_at_the_field_clocks_now():
    repo = clocked(AS_OF, set_minutes_ago=10)
    ahead = datetime.now(timezone.utc) + timedelta(minutes=1)  # inside the allowed skew
    body = send(repo, {**live(), "captured_at": ahead.isoformat()})
    assert at(body["captured_at"]) <= at(body["synced_at"])
    assert abs(at(body["captured_at"]) - (AS_OF + timedelta(minutes=10))) < timedelta(seconds=5)


def test_without_a_demo_clock_a_phone_keeps_its_own_time():
    repo = clocked(None)
    phone_time = datetime.now(timezone.utc) - timedelta(minutes=2)
    body = send(repo, {**live(), "captured_at": phone_time.isoformat()})
    assert at(body["captured_at"]) == phone_time and at(body["device_captured_at"]) == phone_time


def test_the_simulator_already_sends_field_times_and_is_not_mapped():
    repo = clocked(AS_OF)
    sent = payload("E01", hour=9)
    body = send(repo, sent)
    assert at(body["captured_at"]) == at(sent["captured_at"]) and body["device_captured_at"] is None


def test_moving_the_field_clock_restarts_it_from_the_new_as_of():
    repo = clocked(AS_OF, set_minutes_ago=30)
    later = AS_OF + timedelta(hours=4)
    repo.set_as_of(later.isoformat(), forward_only=True)  # a demo step; the clock now runs from 12:00
    body = send(repo, {**live(), "captured_at": datetime.now(timezone.utc).isoformat()})
    assert abs(at(body["captured_at"]) - later) < timedelta(seconds=5)

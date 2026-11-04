"""Data access behind one small interface, so endpoints never talk to Supabase directly.

SupabaseRepo is the real one (PostgREST + service role key; ingest goes
through the ingest_begin / ingest_commit database functions). InMemoryRepo
holds plain dicts, mirrors those functions' semantics, and backs the API
tests. Rows are dicts shaped like the database rows. Every method is scoped
to the one configured project. No scoring decisions are made here.
"""

import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Callable, Iterable, Protocol

from .postgrest import Supabase, SupabaseError, in_list

# Every queued job row carries the same keys (see SupabaseRepo.queue_jobs).
JOB_DEFAULTS = {"submission_id": None, "notify": True, "input": None}

# What the engine reads (engine.Submission.from_row); ingest_begin returns the same for the scoring group.
ENGINE_COLUMNS = ("id,contributor_id,device_id,captured_at,synced_at,duration_sec,lat,lng,answers,voice_transcript,"
                  "gps_accuracy_m,device_captured_at,device_synced_at,received_at")
LIGHT_COLUMNS = "id,contributor_id,device_id,captured_at,duration_sec,lat,lng,source"
LEASE_LOST_CODE = "FQ409"


class Conflict(Exception):
    pass


class NotFound(Exception):
    pass


class LeaseLost(Exception):
    """A commit arrived after one of its leases expired; nothing was written."""


class Repository(Protocol):
    cache_ttl: float  # seconds the service may cache slow-changing reads (0 = never)

    def project(self) -> dict: ...  # id, name, region, timezone, as_of (may be cached; see clock())
    def clock(self) -> dict: ...  # as_of, clock_set_at, day_pin, demo_run_id, read fresh (the demo moves them)
    def set_as_of(self, value: str, forward_only: bool = False) -> None: ...
    def set_demo_run(self, run_id: str) -> None: ...
    def check_params(self) -> dict | None: ...
    def areas(self, boundary: bool = False) -> list[dict]: ...  # id, name (+ boundary GeoJSON)
    def contributors(self) -> list[dict]: ...  # id, code, display_name, kind, area_id
    def submission(self, submission_id: str) -> dict | None: ...
    def submissions(self, *, contributor_ids: Iterable[str] | None = None, device_ids: Iterable[str] | None = None,
                    source: str | None = None, light: bool = False) -> list[dict]: ...
    def scores(self, submission_ids: Iterable[str] | None = None) -> list[dict]: ...
    def check_results(self, submission_id: str) -> list[dict]: ...
    def fired_checks(self, engine_version: str) -> list[dict]: ...  # submission_id, check_key, weight
    def write_results(self, check_rows: list[dict], score_rows: list[dict]) -> int: ...  # bulk, no leases; skips unchanged rows
    def data_version(self, source: str) -> tuple[int, str | None]: ...  # (row count, max synced_at): changes when data does

    # Ingest in two calls. ingest_begin returns {"status": ...}:
    #   duplicate  client_submission_id exists and heal is False: submission, score (or None), checks (fired)
    #   busy       an overlapping lease is held; lock_keys
    #   inserted   new row stored, leases held: submission, lock_keys, group (rows to score with), scores (before)
    #   heal       like inserted, around the existing row (heal=True)
    def ingest_begin(self, row: dict, holder: str, engine_version: str, ttl_seconds: int,
                     heal: bool = False) -> dict: ...
    def ingest_commit(self, check_rows: list[dict], score_rows: list[dict], holder: str,
                      expected_locks: int) -> int: ...  # LeaseLost if a lease expired; releases the leases
    def release_locks(self, holder: str) -> None: ...

    def reviews(self, submission_id: str | None = None) -> list[dict]: ...
    def insert_review(self, row: dict) -> dict: ...  # Conflict if the submission has an active review
    def revoke_review(self, review_id: str) -> dict: ...  # NotFound if missing or already revoked
    def truth_labels(self) -> dict[str, dict]: ...  # only /evaluate may call this

    # Demo controls (/demo/*) ----------------------------------------------------
    def client_ids(self, sources: Iterable[str]) -> dict[str, str]: ...  # client_submission_id -> id
    def write_truth(self, rows: list[dict]) -> int: ...  # upsert labels for rows the demo sent; skips deleted rows
    def delete_submissions(self, sources: Iterable[str]) -> dict[str, int]: ...  # with dependents; counts per table
    def delete_reviews(self) -> int: ...  # every review in the project

    # AI layer: verdicts are inputs to the checks; jobs drive the model work ------
    def verdicts(self, submission_ids: Iterable[str] | None = None) -> list[dict]: ...  # either side of a pair
    def verdict_version(self) -> tuple[int, str | None]: ...  # (count, latest created_at)
    def put_verdict(self, row: dict) -> dict: ...  # replaces the verdict about the same subject
    def set_transcript(self, submission_id: str, transcript: str, lang: str | None) -> None: ...
    def queue_jobs(self, rows: list[dict]) -> list[dict]: ...  # skips dedupe_keys already queued; returns new rows
    def job(self, job_id: str) -> dict | None: ...
    def job_by_key(self, dedupe_key: str) -> dict | None: ...
    def claim_job(self, job_id: str) -> dict | None: ...  # queued (or abandoned) -> running, attempts + 1
    def claim_jobs(self, limit: int) -> list[dict]: ...
    def finish_job(self, job_id: str, values: dict) -> None: ...
    def requeue_job(self, job_id: str) -> dict | None: ...  # a forced rerun
    def pending_jobs(self) -> list[dict]: ...  # queued or running: id, submission_id, kind, status
    def jobs_for(self, submission_id: str) -> list[dict]: ...  # id, kind, status, created_at of one submission's jobs
    def ai_spend(self, run_id: str | None) -> dict: ...  # all_time_usd, all_time_jobs, run_usd, run_jobs
    def signed_upload(self, bucket: str, path: str) -> str: ...  # absolute URL a phone can PUT the file to
    def briefs(self, for_date: str) -> list[dict]: ...  # newest first
    def save_brief(self, row: dict) -> dict: ...  # one per (project, for_date, data_version)
    def brief(self, brief_id: str) -> dict | None: ...
    def set_brief_audio(self, brief_id: str, path: str) -> None: ...
    def download(self, bucket: str, path: str) -> bytes: ...
    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None: ...
    def signed_url(self, bucket: str, path: str, seconds: int) -> str: ...


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# In memory ----------------------------------------------------------------------

class InMemoryRepo:
    cache_ttl = 0.0

    def __init__(self, project: dict, contributors: list[dict], areas: list[dict] | None = None,
                 check_params: dict | None = None, submissions: list[dict] | None = None,
                 truth: list[dict] | None = None, write_delay: float = 0.0,
                 clock: Callable[[], float] = time.monotonic, enforce_leases: bool = True):
        self._project = project
        self._contributors = list(contributors)
        self._areas = list(areas or [])
        self._check_params = check_params
        self._submissions: dict[str, dict] = {s["id"]: dict(s) for s in submissions or []}
        self._truth = {t["submission_id"]: dict(t) for t in truth or []}
        self._check_results: dict[tuple[str, str, str], dict] = {}
        self._scores: dict[str, dict] = {}
        self._reviews: dict[str, dict] = {}
        self._verdicts: dict[tuple[str, str, str | None], dict] = {}
        self._jobs: dict[str, dict] = {}
        self._briefs: dict[str, dict] = {}
        self.files: dict[tuple[str, str], bytes] = {}
        self.locks: dict[str, tuple[str, float]] = {}  # key -> (holder, expires_at)
        self._mutex = threading.Lock()
        self._write_delay = write_delay  # widens race windows in concurrency tests
        self._clock = clock
        self._enforce_leases = enforce_leases  # False only to prove the tests catch races

    def project(self) -> dict:
        return dict(self._project)

    def clock(self):
        return {k: self._project.get(k) for k in ("as_of", "clock_set_at", "day_pin", "demo_run_id")}

    def set_demo_run(self, run_id):
        self._project = {**self._project, "demo_run_id": run_id}

    def set_as_of(self, value, forward_only=False):
        current = self._project.get("as_of")
        if forward_only and (current is None or datetime.fromisoformat(current) >= datetime.fromisoformat(value)):
            return
        if value != current:  # what the projects_clock_set_at trigger does in Postgres
            self._project = {**self._project, "as_of": value, "clock_set_at": _now()}

    def check_params(self) -> dict | None:
        return self._check_params

    def areas(self, boundary=False) -> list[dict]:
        return [{k: v for k, v in a.items() if boundary or k != "boundary"} for a in self._areas]

    def contributors(self) -> list[dict]:
        return [dict(c) for c in self._contributors]

    def data_version(self, source):
        with self._mutex:
            rows = [r for r in self._submissions.values() if r.get("source") == source]
        return len(rows), max((r["synced_at"] for r in rows), default=None)

    def submission(self, submission_id):
        row = self._submissions.get(submission_id)
        return dict(row) if row else None

    def submissions(self, *, contributor_ids=None, device_ids=None, source=None, light=False):
        contributor_ids = set(contributor_ids) if contributor_ids is not None else None
        device_ids = set(device_ids) if device_ids is not None else None
        with self._mutex:
            rows = list(self._submissions.values())
        out = []
        for row in rows:
            if contributor_ids is not None or device_ids is not None:
                if not ((contributor_ids and row["contributor_id"] in contributor_ids)
                        or (device_ids and row.get("device_id") in device_ids)):
                    continue
            if source and row.get("source") != source:
                continue
            out.append(dict(row))
        return sorted(out, key=lambda r: r["id"])

    def scores(self, submission_ids=None):
        with self._mutex:
            rows = list(self._scores.values())
        if submission_ids is not None:
            wanted = set(submission_ids)
            rows = [r for r in rows if r["submission_id"] in wanted]
        return [dict(r) for r in rows]

    def check_results(self, submission_id):
        with self._mutex:
            return [dict(r) for (sid, _, _), r in sorted(self._check_results.items()) if sid == submission_id]

    def fired_checks(self, engine_version):
        with self._mutex:
            return [{"submission_id": r["submission_id"], "check_key": r["check_key"], "weight": r["weight"]}
                    for r in self._check_results.values() if r["fired"] and r["engine_version"] == engine_version]

    def _write(self, check_rows, score_rows) -> int:
        written = 0
        for row in check_rows:
            key = (row["submission_id"], row["check_key"], row["engine_version"])
            old = self._check_results.get(key)
            if old is None or (old["fired"], old["weight"], old["evidence"]) != (row["fired"], row["weight"], row["evidence"]):
                self._check_results[key] = dict(row)
                written += 1
        for row in score_rows:
            old = self._scores.get(row["submission_id"])
            if old is None or any(old[k] != row[k] for k in ("score", "flagged", "config", "engine_version")):
                self._scores[row["submission_id"]] = dict(row)
                written += 1
        return written

    def write_results(self, check_rows, score_rows):
        with self._mutex:
            return self._write(check_rows, score_rows)

    # Ingest, mirroring ingest_begin / ingest_commit -----------------------------

    def _stored_view(self, row: dict, engine_version: str) -> dict:
        score = self._scores.get(row["id"])
        checks = [dict(r) for (sid, _, version), r in sorted(self._check_results.items())
                  if sid == row["id"] and version == engine_version and r["fired"]]
        return {"submission": dict(row), "score": dict(score) if score else None, "checks": checks}

    def ingest_begin(self, row, holder, engine_version, ttl_seconds, heal=False):
        with self._mutex:
            existing = next((r for r in self._submissions.values()
                             if r["client_submission_id"] == row["client_submission_id"]), None)
            if existing and not heal:
                return {"status": "duplicate", **self._stored_view(existing, engine_version)}
            source = existing or row
            cid, did = source["contributor_id"], source.get("device_id")
            subs = list(self._submissions.values())
            contributor_ids = {cid} | {r["contributor_id"] for r in subs if did and r.get("device_id") == did}
            device_ids = ({did} if did else set()) | {r["device_id"] for r in subs
                                                      if r["contributor_id"] == cid and r.get("device_id")}
            keys = sorted([f"contributor:{c}" for c in contributor_ids] + [f"device:{d}" for d in device_ids])

            now = self._clock()
            for key in [k for k, (_, expires) in self.locks.items() if expires <= now]:
                del self.locks[key]
            if self._enforce_leases and any(k in self.locks and self.locks[k][0] != holder for k in keys):
                return {"status": "busy", "lock_keys": keys}
            for key in keys:
                self.locks[key] = (holder, now + ttl_seconds)

            if existing is None:
                stored = {"created_at": _now(), "voice_note_path": None, **row}
                self._submissions[row["id"]] = stored
            else:
                stored = existing
            group = [{k: r.get(k) for k in ENGINE_COLUMNS.split(",")} for r in self._submissions.values()
                     if r["contributor_id"] in contributor_ids or r.get("device_id") in device_ids]
            ids = {r["id"] for r in group}
            scores = [{k: s[k] for k in ("submission_id", "score", "flagged", "engine_version")}
                      for s in self._scores.values() if s["submission_id"] in ids]
            verdicts = [{k: v.get(k) for k in ("submission_id", "pair_submission_id", "kind", "model", "verdict")}
                        for v in self._verdicts.values() if v["submission_id"] in ids]
            return {"status": "heal" if existing else "inserted", "submission": dict(stored), "lock_keys": keys,
                    "group": sorted(group, key=lambda r: r["id"]), "scores": scores, "verdicts": verdicts}

    def ingest_commit(self, check_rows, score_rows, holder, expected_locks):
        if self._write_delay:
            time.sleep(self._write_delay)
        with self._mutex:
            now = self._clock()
            held = sum(1 for h, expires in self.locks.values() if h == holder and expires > now)
            if self._enforce_leases and held < expected_locks:
                raise LeaseLost(f"holding {held}, expected {expected_locks}")
            written = self._write(check_rows, score_rows)
            for key in [k for k, (h, _) in self.locks.items() if h == holder]:
                del self.locks[key]
            return written

    def release_locks(self, holder):
        with self._mutex:
            for key in [k for k, (h, _) in self.locks.items() if h == holder]:
                del self.locks[key]

    # Reviews and truth ------------------------------------------------------------

    def reviews(self, submission_id=None):
        with self._mutex:
            rows = [dict(r) for r in self._reviews.values()
                    if submission_id is None or r["submission_id"] == submission_id]
        return sorted(rows, key=lambda r: r["created_at"])

    def insert_review(self, row):
        with self._mutex:
            if any(r["submission_id"] == row["submission_id"] and r["revoked_at"] is None
                   for r in self._reviews.values()):
                raise Conflict(row["submission_id"])
            stored = {"id": str(uuid.uuid4()), "created_at": _now(), "revoked_at": None, **row}
            self._reviews[stored["id"]] = stored
            return dict(stored)

    def revoke_review(self, review_id):
        with self._mutex:
            row = self._reviews.get(review_id)
            if row is None or row["revoked_at"] is not None:
                raise NotFound(review_id)
            row["revoked_at"] = _now()
            return dict(row)

    def truth_labels(self):
        return {sid: {"fraud_type": t["fraud_type"], "noise_tag": t.get("noise_tag")}
                for sid, t in self._truth.items()
                if self._submissions.get(sid, {}).get("source") == "synthetic"}

    # Demo controls ----------------------------------------------------------------

    def client_ids(self, sources):
        wanted = set(sources)
        with self._mutex:
            return {r["client_submission_id"]: r["id"] for r in self._submissions.values() if r.get("source") in wanted}

    def write_truth(self, rows):
        with self._mutex:
            kept = [r for r in rows if r["submission_id"] in self._submissions]
            for row in kept:
                self._truth[row["submission_id"]] = dict(row)
            return len(kept)

    def delete_submissions(self, sources):
        wanted = set(sources)
        with self._mutex:
            ids = {sid for sid, r in self._submissions.items() if r.get("source") in wanted}
            counts = {
                "submissions": len(ids),
                "check_results": sum(sid in ids for sid, _, _ in self._check_results),
                "scores": sum(sid in ids for sid in self._scores),
                "reviews": sum(r["submission_id"] in ids for r in self._reviews.values()),
                "ai_jobs": 0,  # detached below, not deleted
                "synthetic_truth": sum(sid in ids for sid in self._truth),
            }
            for sid in ids:
                del self._submissions[sid]
                self._scores.pop(sid, None)
                self._truth.pop(sid, None)
            self._check_results = {k: v for k, v in self._check_results.items() if k[0] not in ids}
            self._reviews = {k: v for k, v in self._reviews.items() if v["submission_id"] not in ids}
            self._verdicts = {k: v for k, v in self._verdicts.items()
                              if v["submission_id"] not in ids and v.get("pair_submission_id") not in ids}
            for job in self._jobs.values():  # kept, detached: what they cost survives the reset
                if job.get("submission_id") in ids:
                    counts["ai_jobs"] += 1
                    job["submission_id"] = None
            return counts

    def delete_reviews(self):
        with self._mutex:
            removed = len(self._reviews)
            self._reviews.clear()
            return removed

    # AI layer -------------------------------------------------------------------------

    def verdicts(self, submission_ids=None):
        wanted = set(submission_ids) if submission_ids is not None else None
        with self._mutex:
            rows = [dict(v) for v in self._verdicts.values()
                    if v["submission_id"] in self._submissions
                    and (wanted is None or v["submission_id"] in wanted or v.get("pair_submission_id") in wanted)]
        return sorted(rows, key=lambda v: (v["submission_id"], v["kind"], v.get("pair_submission_id") or ""))

    def verdict_version(self):
        rows = self.verdicts()
        return len(rows), max((v["created_at"] for v in rows), default=None)

    def put_verdict(self, row):
        with self._mutex:
            if row["submission_id"] not in self._submissions:
                raise NotFound(row["submission_id"])
            stored = {"id": str(uuid.uuid4()), "created_at": _now(), "pair_submission_id": None, **row}
            self._verdicts[(row["submission_id"], row["kind"], stored["pair_submission_id"])] = stored
            return dict(stored)

    def set_transcript(self, submission_id, transcript, lang):
        with self._mutex:
            self._submissions[submission_id].update(voice_transcript=transcript, transcript_lang=lang)

    def queue_jobs(self, rows):
        with self._mutex:
            taken = {j["dedupe_key"] for j in self._jobs.values()}
            new = []
            for row in rows:
                if row["dedupe_key"] in taken:
                    continue
                job = {"id": str(uuid.uuid4()), "status": "queued", "attempts": 0, "notify": True, "created_at": _now(),
                       "started_at": None, "finished_at": None, "output": None, "error": None, "submission_id": None,
                       "project_id": None, "input": None, "demo_run_id": None, **row}
                sub = self._submissions.get(job["submission_id"] or "")
                if job["demo_run_id"] is None and sub and sub.get("source") in ("simulator", "live"):
                    job["demo_run_id"] = self._project.get("demo_run_id")  # as the database trigger does
                self._jobs[job["id"]] = job
                taken.add(row["dedupe_key"])
                new.append(dict(job))
            return new

    def job(self, job_id):
        row = self._jobs.get(job_id)
        return dict(row) if row else None

    def job_by_key(self, dedupe_key):
        row = next((j for j in self._jobs.values() if j["dedupe_key"] == dedupe_key), None)
        return dict(row) if row else None

    def claim_job(self, job_id):
        with self._mutex:
            row = self._jobs.get(job_id)
            if row is None or row["status"] != "queued":
                return None
            row.update(status="running", attempts=row["attempts"] + 1, started_at=_now(), error=None)
            return dict(row)

    def claim_jobs(self, limit):
        queued = sorted((j for j in self._jobs.values() if j["status"] == "queued"), key=lambda j: j["created_at"])
        return [c for c in (self.claim_job(j["id"]) for j in queued[:limit]) if c]

    def finish_job(self, job_id, values):
        with self._mutex:
            if job_id in self._jobs:
                self._jobs[job_id].update(values, finished_at=_now())

    def requeue_job(self, job_id):
        with self._mutex:
            row = self._jobs.get(job_id)
            if row is None or row["status"] == "running":
                return None
            row.update(status="queued", error=None)
            return dict(row)

    def pending_jobs(self):
        return [{k: j[k] for k in ("id", "submission_id", "kind", "status")}
                for j in self._jobs.values() if j["status"] in ("queued", "running")]

    def jobs_for(self, submission_id):
        return [{k: j.get(k) for k in ("id", "kind", "status", "created_at")}
                for j in self._jobs.values() if j.get("submission_id") == submission_id]

    def ai_spend(self, run_id):
        jobs = list(self._jobs.values())
        cost = lambda js: round(sum(float(j.get("cost_usd") or 0) for j in js), 6)  # noqa: E731
        mine = [j for j in jobs if run_id and j.get("demo_run_id") == run_id]
        return {"all_time_usd": cost(jobs), "all_time_jobs": len(jobs), "run_usd": cost(mine), "run_jobs": len(mine)}

    def signed_upload(self, bucket, path):
        return f"memory://upload/{bucket}/{path}"

    def briefs(self, for_date):
        rows = [dict(b) for b in self._briefs.values() if b["for_date"] == for_date]
        return sorted(rows, key=lambda b: b["created_at"], reverse=True)

    def save_brief(self, row):
        with self._mutex:
            existing = next((b for b in self._briefs.values() if (b["for_date"], b["data_version"]) ==
                             (row["for_date"], row["data_version"])), None)
            stored = {**(existing or {"id": str(uuid.uuid4()), "audio_path": None}), **row, "created_at": _now()}
            self._briefs[stored["id"]] = stored
            return dict(stored)

    def brief(self, brief_id):
        row = self._briefs.get(brief_id)
        return dict(row) if row else None

    def set_brief_audio(self, brief_id, path):
        self._briefs[brief_id]["audio_path"] = path

    def download(self, bucket, path):
        if (bucket, path) not in self.files:
            raise NotFound(f"{bucket}/{path}")
        return self.files[(bucket, path)]

    def upload(self, bucket, path, data, content_type):
        self.files[(bucket, path)] = data

    def signed_url(self, bucket, path, seconds):
        return f"memory://{bucket}/{path}?expires={seconds}"


# Supabase ---------------------------------------------------------------------

class SupabaseRepo:
    cache_ttl = 60.0

    def __init__(self, client: Supabase, project_id: str | None = None):
        self._db = client
        self._project_id = project_id
        self._project: dict | None = None

    def project(self) -> dict:
        if self._project is None:
            filters = {"id": f"eq.{self._project_id}"} if self._project_id else {}
            rows = self._db.select("projects", "id,name,region,timezone,as_of", order="created_at", **filters)
            if len(rows) != 1:
                raise RuntimeError(f"expected one project, found {len(rows)}; set PROJECT_ID")
            self._project = rows[0]
        return dict(self._project)

    @property
    def _pid(self) -> str:
        return self.project()["id"]

    def clock(self):
        rows = self._db.select("projects", "as_of,clock_set_at,day_pin,demo_run_id", id=f"eq.{self._pid}")
        return rows[0] if rows else {"as_of": None, "clock_set_at": None, "day_pin": None, "demo_run_id": None}

    def set_demo_run(self, run_id):
        self._db.update("projects", {"demo_run_id": run_id}, id=f"eq.{self._pid}")

    def set_as_of(self, value, forward_only=False):
        filters = {"id": f"eq.{self._pid}"}
        if forward_only:
            filters["as_of"] = f"lt.{value}"  # never moves the clock back when two tabs step at once
        self._db.update("projects", {"as_of": value}, **filters)

    def _in_project(self) -> dict:
        return {"project_id": f"eq.{self._pid}"}

    def check_params(self):
        rows = self._db.select("check_config", "params", **self._in_project())
        return rows[0]["params"] if rows else None

    def areas(self, boundary=False):
        return self._db.select("areas", "id,name,boundary" if boundary else "id,name", order="name", **self._in_project())

    def data_version(self, source):
        row, count = self._db.first("submissions", "synced_at", order="synced_at.desc",
                                    source=f"eq.{source}", **self._in_project())
        return count, row["synced_at"] if row else None

    def contributors(self):
        return self._db.select("contributors", "id,code,display_name,kind,area_id", order="code", **self._in_project())

    def submission(self, submission_id):
        rows = self._db.select("submissions", "*", id=f"eq.{submission_id}", **self._in_project())
        return rows[0] if rows else None

    def submissions(self, *, contributor_ids=None, device_ids=None, source=None, light=False):
        filters = {**self._in_project(), "order": "id"}
        parts = []
        if contributor_ids:
            parts.append(f"contributor_id.{in_list(sorted(contributor_ids))}")
        if device_ids:
            parts.append(f"device_id.{in_list(sorted(device_ids))}")
        if parts:
            filters["or"] = "(" + ",".join(parts) + ")"
        elif contributor_ids is not None or device_ids is not None:
            return []
        if source:
            filters["source"] = f"eq.{source}"
        columns = LIGHT_COLUMNS if light else ENGINE_COLUMNS + ",client_submission_id,source,project_id"
        # Paged reads: a row inserted mid-read (a phone syncing) can shift a page boundary
        # and repeat a row on the next page. Keep each submission once.
        rows = self._db.select("submissions", columns, **filters)
        return list({r["id"]: r for r in rows}.values())

    def scores(self, submission_ids=None):
        columns = "submission_id,score,flagged,engine_version,scored_at"
        if submission_ids is None:
            rows = self._db.select("scores", columns + ",submissions!inner(project_id)",
                                   **{"submissions.project_id": f"eq.{self._pid}"})
            for row in rows:
                row.pop("submissions", None)
            return rows
        ids = sorted(set(submission_ids))
        out = []
        for start in range(0, len(ids), 100):
            out += self._db.select("scores", columns, submission_id=in_list(ids[start:start + 100]))
        return out

    def check_results(self, submission_id):
        return self._db.select("check_results", "*", submission_id=f"eq.{submission_id}", order="check_key")

    def fired_checks(self, engine_version):
        rows = self._db.select("check_results", "submission_id,check_key,weight,submissions!inner(project_id)",
                               fired="is.true", engine_version=f"eq.{engine_version}",
                               **{"submissions.project_id": f"eq.{self._pid}"})
        for row in rows:
            row.pop("submissions", None)
        return rows

    def write_results(self, check_rows, score_rows, batch_submissions: int = 250):
        """Same skip-unchanged write as ingest_commit, with a fresh holder that owns no leases."""
        written = 0
        ids = [r["submission_id"] for r in score_rows]
        for start in range(0, len(ids), batch_submissions):
            chunk = set(ids[start:start + batch_submissions])
            written += self._db.rpc("ingest_commit", {
                "check_rows": [r for r in check_rows if r["submission_id"] in chunk],
                "score_rows": [r for r in score_rows if r["submission_id"] in chunk],
                "lock_holder": str(uuid.uuid4()), "expected_locks": 0,
            })
        return written

    def ingest_begin(self, row, holder, engine_version, ttl_seconds, heal=False):
        return self._db.rpc("ingest_begin", {
            "submission": {**row, "project_id": self._pid}, "lock_holder": holder,
            "engine_version": engine_version, "ttl_seconds": ttl_seconds, "heal": heal,
        })

    def ingest_commit(self, check_rows, score_rows, holder, expected_locks):
        try:
            return self._db.rpc("ingest_commit", {"check_rows": check_rows, "score_rows": score_rows,
                                                  "lock_holder": holder, "expected_locks": expected_locks})
        except SupabaseError as error:
            if error.code == LEASE_LOST_CODE:
                raise LeaseLost(str(error)) from error
            raise

    def release_locks(self, holder):
        self._db.rpc("release_scoring_locks", {"lock_holder": holder})

    def reviews(self, submission_id=None):
        if submission_id:
            return self._db.select("reviews", "*", submission_id=f"eq.{submission_id}", order="created_at")
        rows = self._db.select("reviews", "*,submissions!inner(project_id)", order="created_at",
                               **{"submissions.project_id": f"eq.{self._pid}"})
        for row in rows:
            row.pop("submissions", None)
        return rows

    def insert_review(self, row):
        try:
            return self._db.insert("reviews", [row], returning=True)[0]
        except SupabaseError as error:
            if error.code == "23505":
                raise Conflict(row["submission_id"]) from error
            raise

    def revoke_review(self, review_id):
        rows = self._db.update("reviews", {"revoked_at": _now()}, id=f"eq.{review_id}", revoked_at="is.null")
        if not rows:
            raise NotFound(review_id)
        return rows[0]

    def truth_labels(self):
        rows = self._db.select("synthetic_truth", "submission_id,fraud_type,noise_tag,submissions!inner(project_id,source)",
                               **{"submissions.project_id": f"eq.{self._pid}", "submissions.source": "eq.synthetic"})
        return {r["submission_id"]: {"fraud_type": r["fraud_type"], "noise_tag": r["noise_tag"]} for r in rows}

    # Demo controls ----------------------------------------------------------------

    def client_ids(self, sources):
        rows = self._db.select("submissions", "id,client_submission_id", order="id",
                               source=in_list(sorted(set(sources))), **self._in_project())
        return {r["client_submission_id"]: r["id"] for r in rows}

    def write_truth(self, rows):
        try:
            self._db.upsert("synthetic_truth", rows, on_conflict="submission_id")
            return len(rows)
        except SupabaseError as error:
            if error.code != "23503":
                raise
        # A reset deleted some of these submissions meanwhile: write the rest one by one.
        written = 0
        for row in rows:
            try:
                self._db.upsert("synthetic_truth", [row], on_conflict="submission_id")
                written += 1
            except SupabaseError as error:
                if error.code != "23503":
                    raise
        return written

    def delete_submissions(self, sources):
        """Counts first (dependents through an inner join), then one delete that cascades to all of them."""
        source = in_list(sorted(set(sources)))
        joined = {"submissions.project_id": f"eq.{self._pid}", "submissions.source": source}
        counts = {"submissions": self._db.count("submissions", "id", source=source, **self._in_project())}
        for table in ("check_results", "scores", "reviews", "ai_jobs", "synthetic_truth"):
            counts[table] = self._db.count(table, "submission_id,submissions!inner(project_id,source)", **joined)
        self._db.delete("submissions", source=source, **self._in_project())
        return counts

    def delete_reviews(self):
        ids = [r["id"] for r in self.reviews()]
        for start in range(0, len(ids), 100):
            self._db.delete("reviews", id=in_list(ids[start:start + 100]))
        return len(ids)

    # AI layer -------------------------------------------------------------------------

    _VERDICT_COLUMNS = "id,submission_id,pair_submission_id,kind,model,verdict,created_at"
    # ai_verdicts has two keys into submissions (the pair): embed through submission_id.
    _VERDICT_PROJECT = "submissions!ai_verdicts_submission_id_fkey!inner(project_id)"

    def verdicts(self, submission_ids=None):
        if submission_ids is None:
            rows = self._db.select("ai_verdicts", self._VERDICT_COLUMNS + "," + self._VERDICT_PROJECT,
                                   order="id", **{"submissions.project_id": f"eq.{self._pid}"})
            for row in rows:
                row.pop("submissions", None)
            return rows
        ids = sorted(set(submission_ids))
        out: dict[str, dict] = {}
        for start in range(0, len(ids), 100):
            chunk = in_list(ids[start:start + 100])
            for row in self._db.select("ai_verdicts", self._VERDICT_COLUMNS,
                                       **{"or": f"(submission_id.{chunk},pair_submission_id.{chunk})"}):
                out[row["id"]] = row
        return list(out.values())

    def verdict_version(self):
        row, count = self._db.first("ai_verdicts", "created_at," + self._VERDICT_PROJECT, order="created_at.desc",
                                    **{"submissions.project_id": f"eq.{self._pid}"})
        return count, row["created_at"] if row else None

    def put_verdict(self, row):
        pair = row.get("pair_submission_id")
        filters = {"submission_id": f"eq.{row['submission_id']}", "kind": f"eq.{row['kind']}",
                   "pair_submission_id": f"eq.{pair}" if pair else "is.null"}
        self._db.delete("ai_verdicts", **filters)
        try:
            return self._db.insert("ai_verdicts", [row], returning=True)[0]
        except SupabaseError as error:
            if error.code == "23503":  # the submission was deleted meanwhile (a demo reset)
                raise NotFound(row["submission_id"]) from error
            raise

    def set_transcript(self, submission_id, transcript, lang):
        self._db.update("submissions", {"voice_transcript": transcript, "transcript_lang": lang},
                        id=f"eq.{submission_id}")

    def queue_jobs(self, rows):
        if not rows:
            return []
        # PostgREST takes a bulk insert only when every row has the same keys: a transcription (no
        # notify key) queued with a paraphrase check was refused whole, and the arrival got no model work.
        rows = [{**JOB_DEFAULTS, "project_id": self._pid, **r} for r in rows]
        return self._db.upsert_returning("ai_jobs", rows, on_conflict="dedupe_key", ignore=True)

    def job(self, job_id):
        rows = self._db.select("ai_jobs", "*", id=f"eq.{job_id}")
        return rows[0] if rows else None

    def job_by_key(self, dedupe_key):
        rows = self._db.select("ai_jobs", "*", dedupe_key=f"eq.{dedupe_key}")
        return rows[0] if rows else None

    def claim_job(self, job_id):
        rows = self._db.rpc("claim_ai_job", {"job_id": job_id})
        return rows[0] if rows else None

    def claim_jobs(self, limit):
        return self._db.rpc("claim_ai_jobs", {"max_jobs": limit}) or []

    def finish_job(self, job_id, values):
        self._db.update("ai_jobs", {**values, "finished_at": _now()}, id=f"eq.{job_id}")

    def requeue_job(self, job_id):
        rows = self._db.update("ai_jobs", {"status": "queued", "error": None}, id=f"eq.{job_id}",
                               status="in.(done,failed)")
        return rows[0] if rows else None

    def pending_jobs(self):
        return self._db.select("ai_jobs", "id,submission_id,kind,status", status="in.(queued,running)",
                               project_id=f"eq.{self._pid}")

    def jobs_for(self, submission_id):
        return self._db.select("ai_jobs", "id,kind,status,created_at", submission_id=f"eq.{submission_id}",
                               order="created_at")

    def ai_spend(self, run_id):
        return self._db.rpc("ai_spend", {"project": self._pid, "run": run_id})

    def signed_upload(self, bucket, path):
        return self._db.signed_upload_url(bucket, path)

    def briefs(self, for_date):
        return self._db.select("briefs", "*", order="created_at.desc", for_date=f"eq.{for_date}", **self._in_project())

    def save_brief(self, row):
        return self._db.upsert_returning("briefs", [{"project_id": self._pid, **row, "created_at": _now()}],
                                         on_conflict="project_id,for_date,data_version")[0]

    def brief(self, brief_id):
        rows = self._db.select("briefs", "*", id=f"eq.{brief_id}", **self._in_project())
        return rows[0] if rows else None

    def set_brief_audio(self, brief_id, path):
        self._db.update("briefs", {"audio_path": path}, id=f"eq.{brief_id}")

    def download(self, bucket, path):
        return self._db.download(bucket, path)

    def upload(self, bucket, path, data, content_type):
        self._db.upload(bucket, path, data, content_type)

    def signed_url(self, bucket, path, seconds):
        return self._db.signed_url(bucket, path, seconds)

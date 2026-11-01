"""What the endpoints do, independent of FastAPI and of the storage behind the Repository."""

import time
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from statistics import median
from zoneinfo import ZoneInfo

from engine import CheckResult, Contributor, Params, ScoredSubmission, Submission, __version__, score_all, score_incremental
from engine.insights import area_rates, contributor_stats, hotspots

from .repo import Conflict, Repository
from .schemas import ReviewIn, SubmissionIn

LOCK_TTL_SECONDS = 15
LOCK_WAIT_SECONDS = 8.0


class Busy(Exception):
    """Another arrival for the same contributor or device is being scored; retry shortly."""


class UnknownContributor(Exception):
    pass


@dataclass(frozen=True)
class ProjectContext:
    project: dict
    params: Params
    contributors: dict[str, Contributor]  # by id
    contributor_rows: dict[str, dict]  # by id: code, display_name, kind, area_id
    by_code: dict[str, dict]
    area_names: dict[str, str]  # area id -> name


def _cached(repo: Repository, name: str, load):
    ttl = getattr(repo, "cache_ttl", 0)
    if not ttl:
        return load()
    cache = repo.__dict__.setdefault("_service_cache", {})
    hit = cache.get(name)
    if hit and time.monotonic() - hit[0] < ttl:
        return hit[1]
    value = load()
    cache[name] = (time.monotonic(), value)
    return value


def context(repo: Repository) -> ProjectContext:
    def load() -> ProjectContext:
        project = repo.project()
        rows = repo.contributors()
        return ProjectContext(
            project=project,
            params=Params.from_config(repo.check_params(), timezone=project["timezone"]),
            contributors={r["id"]: Contributor.from_row(r) for r in rows},
            contributor_rows={r["id"]: r for r in rows},
            by_code={r["code"]: r for r in rows},
            area_names={a["id"]: a["name"] for a in repo.areas()},
        )
    return _cached(repo, "context", load)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def _result_rows(scored: list[ScoredSubmission], params: Params, scored_at: str) -> tuple[list[dict], list[dict]]:
    checks = [
        {"submission_id": s.submission_id, "check_key": r.key, "fired": r.fired, "weight": r.weight,
         "evidence": r.evidence, "engine_version": s.engine_version}
        for s in scored for r in s.results
    ]
    scores = [
        {"submission_id": s.submission_id, "score": s.score, "flagged": s.flagged, "config": params.to_dict(),
         "engine_version": s.engine_version, "scored_at": scored_at}
        for s in scored
    ]
    return checks, scores


def _contributor_view(ctx: ProjectContext, contributor_id: str) -> dict:
    row = ctx.contributor_rows[contributor_id]
    return {"id": row["id"], "code": row["code"], "display_name": row.get("display_name"), "kind": row["kind"],
            "area": ctx.area_names.get(row.get("area_id"))}


# POST /submissions --------------------------------------------------------------

def _acquire(repo: Repository, keys: list[str], holder: str) -> None:
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    pause = 0.05
    while not repo.acquire_locks(keys, holder, LOCK_TTL_SECONDS):
        if time.monotonic() > deadline:
            raise Busy(", ".join(keys))
        time.sleep(pause)
        pause = min(pause * 2, 0.4)


def _stored_view(repo: Repository, ctx: ProjectContext, row: dict, duplicate: bool) -> dict:
    score = next(iter(repo.scores([row["id"]])), None)
    fired = [{"key": r["check_key"], "weight": r["weight"], "evidence": r["evidence"]}
             for r in repo.check_results(row["id"]) if r["fired"] and (not score or r["engine_version"] == score["engine_version"])]
    return {
        "id": row["id"],
        "client_submission_id": row["client_submission_id"],
        "contributor": _contributor_view(ctx, row["contributor_id"]),
        "captured_at": row["captured_at"],
        "synced_at": row["synced_at"],
        "score": score["score"] if score else None,
        "flagged": score["flagged"] if score else None,
        "band": ctx.params.band(score["score"]) if score else None,
        "engine_version": score["engine_version"] if score else None,
        "fired": fired,
        "changed": [],
        "duplicate": duplicate,
    }


def ingest(repo: Repository, payload: SubmissionIn) -> tuple[int, dict]:
    """Store a phone's submission, score it and everything it affects. (201, view) or (200, view) on a retry."""
    ctx = context(repo)
    existing = repo.submission_by_client_id(payload.client_submission_id)
    if existing:
        return 200, _stored_view(repo, ctx, existing, duplicate=True)
    contributor = ctx.by_code.get(payload.contributor_code)
    if contributor is None:
        raise UnknownContributor(payload.contributor_code)

    holder = str(uuid.uuid4())
    keys = sorted({f"contributor:{contributor['id']}", f"device:{payload.device_id}"})
    _acquire(repo, keys, holder)
    try:
        row = {
            "id": str(uuid.uuid4()),
            "contributor_id": contributor["id"],
            "client_submission_id": payload.client_submission_id,
            "device_id": payload.device_id,
            "captured_at": _iso(payload.captured_at),
            "synced_at": _iso(datetime.now(timezone.utc)),  # the server decides when it received it
            "duration_sec": payload.duration_sec,
            "lat": payload.lat,
            "lng": payload.lng,
            "gps_accuracy_m": payload.gps_accuracy_m,
            "answers": payload.answers.model_dump(),
            "voice_transcript": payload.voice_transcript,
            "transcript_lang": "en" if payload.voice_transcript else None,
            "source": payload.source,
        }
        try:
            stored = repo.insert_submission(row)
        except Conflict:  # the same retry raced us between the lookup and the insert
            return 200, _stored_view(repo, ctx, repo.submission_by_client_id(payload.client_submission_id), True)
        new = Submission.from_row(stored)

        # Everything whose result this arrival may change, plus what those need as context.
        group = repo.submissions(contributor_ids=[new.contributor_id], device_ids=[new.device_id])
        contributor_ids = {r["contributor_id"] for r in group}
        device_ids = {r["device_id"] for r in group if r.get("device_id")} | {new.device_id}
        if contributor_ids != {new.contributor_id} or device_ids != {new.device_id}:
            group = repo.submissions(contributor_ids=contributor_ids, device_ids=device_ids)
        existing_subs = [Submission.from_row(r) for r in group if r["id"] != new.id]

        scored = score_incremental(new, existing_subs, ctx.contributors, ctx.params)
        before = {s["submission_id"]: s["flagged"] for s in repo.scores([s.submission_id for s in scored[1:]])}
        check_rows, score_rows = _result_rows(scored, ctx.params, _iso(datetime.now(timezone.utc)))
        repo.save_scores(check_rows, score_rows)
    finally:
        repo.release_locks(holder)

    mine = scored[0]
    changed = [
        {"submission_id": s.submission_id, "flagged": s.flagged, "previously_flagged": before.get(s.submission_id, False),
         "score": s.score}
        for s in scored[1:] if before.get(s.submission_id, False) != s.flagged
    ]
    return 201, {
        "id": stored["id"],
        "client_submission_id": stored["client_submission_id"],
        "contributor": _contributor_view(ctx, stored["contributor_id"]),
        "captured_at": stored["captured_at"],
        "synced_at": stored["synced_at"],
        "score": mine.score,
        "flagged": mine.flagged,
        "band": ctx.params.band(mine.score),
        "engine_version": mine.engine_version,
        "fired": [{"key": r.key, "weight": r.weight, "evidence": r.evidence} for r in mine.results if r.fired],
        "changed": changed,
        "rescored": len(scored) - 1,
        "duplicate": False,
    }


# GET /submissions/{id} -------------------------------------------------------------

def submission_detail(repo: Repository, submission_id: str) -> dict | None:
    row = repo.submission(submission_id)
    if row is None:
        return None
    ctx = context(repo)
    score = next(iter(repo.scores([submission_id])), None)
    version = score["engine_version"] if score else __version__
    checks = [{"key": r["check_key"], "fired": r["fired"], "weight": r["weight"], "evidence": r["evidence"]}
              for r in repo.check_results(submission_id) if r["engine_version"] == version]
    reviews = repo.reviews(submission_id)
    return {
        "submission": {k: row.get(k) for k in (
            "id", "client_submission_id", "device_id", "captured_at", "synced_at", "duration_sec", "lat", "lng",
            "gps_accuracy_m", "answers", "voice_transcript", "transcript_lang", "voice_note_path", "source")},
        "contributor": _contributor_view(ctx, row["contributor_id"]),
        "score": None if score is None else {**score, "band": ctx.params.band(score["score"])},
        "checks": checks,
        "review": reviews[-1] if reviews else None,
    }


# Snapshot for queue and overview ------------------------------------------------------

@dataclass
class Snapshot:
    ctx: ProjectContext
    submissions: dict[str, Submission]
    scored: list[ScoredSubmission]
    fired: dict[str, list[str]]
    active_reviews: dict[str, dict]


def snapshot(repo: Repository) -> Snapshot:
    ctx = context(repo)
    subs = {r["id"]: Submission.from_row(r) for r in repo.submissions(light=True)}
    fired: dict[str, list[CheckResult]] = {}
    for r in repo.fired_checks(__version__):
        fired.setdefault(r["submission_id"], []).append(CheckResult(r["check_key"], True, r["weight"], {}))
    scored = [
        ScoredSubmission(s["submission_id"], s["score"], s["flagged"],
                         tuple(sorted(fired.get(s["submission_id"], []), key=lambda c: c.key)), s["engine_version"])
        for s in repo.scores() if s["submission_id"] in subs
    ]
    active = {r["submission_id"]: r for r in repo.reviews() if r.get("revoked_at") is None}
    return Snapshot(ctx, subs, scored, {k: sorted(c.key for c in v) for k, v in fired.items()}, active)


def queue(repo: Repository, status: str, contributor: str | None, band: str, limit: int) -> dict:
    snap = snapshot(repo)
    params = snap.ctx.params
    items = []
    for s in snap.scored:
        sub = snap.submissions[s.submission_id]
        row = snap.ctx.contributor_rows[sub.contributor_id]
        if params.band(s.score) != band or (contributor and row["code"] != contributor):
            continue
        review = snap.active_reviews.get(s.submission_id)
        if (status == "pending" and review) or (status == "decided" and not review):
            continue
        items.append({
            "submission_id": s.submission_id,
            "contributor": _contributor_view(snap.ctx, sub.contributor_id),
            "captured_at": _iso(sub.captured_at),
            "score": s.score,
            "band": band,
            "fired": snap.fired.get(s.submission_id, []),
            "review": None if review is None else {k: review[k] for k in ("id", "decision", "reviewer", "created_at")},
        })
    items.sort(key=lambda i: (-i["score"], i["captured_at"], i["submission_id"]))
    return {"total": len(items), "items": items[:limit]}


# Reviews ------------------------------------------------------------------------------

def create_review(repo: Repository, body: ReviewIn) -> dict:
    if repo.submission(str(body.submission_id)) is None:
        raise LookupError(str(body.submission_id))
    return repo.insert_review({"submission_id": str(body.submission_id), "decision": body.decision,
                               "note": body.note, "reviewer": body.reviewer or "demo"})


# GET /overview --------------------------------------------------------------------------

def overview(repo: Repository, day: date | None = None) -> dict:
    snap = snapshot(repo)
    params = snap.ctx.params
    tz = ZoneInfo(params.timezone)
    day = day or (datetime.now(tz).date() - timedelta(days=1))
    bands = [params.band(s.score) for s in snap.scored]
    flagged_ids = {s.submission_id for s, b in zip(snap.scored, bands) if b == "flagged"}
    subs = list(snap.submissions.values())
    contributors = contributor_stats(snap.scored, subs, snap.ctx.contributors, params)
    for row in contributors:
        info = snap.ctx.contributor_rows[row["contributor_id"]]
        row["display_name"] = info.get("display_name")
        row["area"] = snap.ctx.area_names.get(info.get("area_id"))
    area_of = {cid: snap.ctx.area_names.get(r.get("area_id"), "unknown") for cid, r in snap.ctx.contributor_rows.items()}

    on_day = [s for s in snap.scored if snap.submissions[s.submission_id].local_date(tz) == day]
    day_flagged = [s for s in on_day if params.band(s.score) == "flagged"]
    day_checks: dict[str, int] = {}
    day_by_contributor: dict[str, int] = {}
    for s in on_day:
        for key in snap.fired.get(s.submission_id, []):
            day_checks[key] = day_checks.get(key, 0) + 1
    for s in day_flagged:
        code = snap.ctx.contributor_rows[snap.submissions[s.submission_id].contributor_id]["code"]
        day_by_contributor[code] = day_by_contributor.get(code, 0) + 1
    day_durations = [snap.submissions[s.submission_id].duration_sec for s in on_day
                     if snap.submissions[s.submission_id].duration_sec is not None]

    return {
        "project": snap.ctx.project,
        "engine_version": __version__,
        "thresholds": {"review": params.review_threshold, "watch": params.watch_threshold},
        "kpis": {
            "received": len(snap.scored),
            "flagged": bands.count("flagged"),
            "watch": bands.count("watch"),
            "pending_review": len(flagged_ids - set(snap.active_reviews)),
            "contributors_to_investigate": sum(r["investigate"] for r in contributors),
        },
        "contributors": contributors,
        "areas": area_rates(snap.scored, subs, area_of, params),
        "hotspots": hotspots(snap.scored, subs, snap.ctx.contributors, params),
        "yesterday": {
            "date": day.isoformat(),
            "received": len(on_day),
            "flagged": len(day_flagged),
            "watch": sum(params.band(s.score) == "watch" for s in on_day),
            "pending_review": sum(s.submission_id not in snap.active_reviews for s in day_flagged),
            "median_duration_sec": median(day_durations) if day_durations else None,
            "checks_fired": dict(sorted(day_checks.items(), key=lambda kv: -kv[1])),
            "flagged_by_contributor": dict(sorted(day_by_contributor.items(), key=lambda kv: (-kv[1], kv[0]))),
        },
    }


# POST /rescore ------------------------------------------------------------------------

def rescore(repo: Repository) -> dict:
    started = time.perf_counter()
    ctx = context(repo)
    subs = [Submission.from_row(r) for r in repo.submissions()]
    scored = score_all(subs, ctx.contributors, ctx.params)
    score_ms = (time.perf_counter() - started) * 1000
    check_rows, score_rows = _result_rows(scored, ctx.params, _iso(datetime.now(timezone.utc)))
    repo.save_scores(check_rows, score_rows)
    return {
        "submissions": len(scored),
        "flagged": sum(s.flagged for s in scored),
        "check_results": len(check_rows),
        "engine_version": __version__,
        "score_ms": round(score_ms),
        "total_ms": round((time.perf_counter() - started) * 1000),
    }

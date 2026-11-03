"""FastAPI app. Deployed as a Vercel Python function; every route lives under /api/py.

Read endpoints are public. Write endpoints need the X-Demo-Passcode header.
"""

import hmac
import json
import sys
from datetime import date
from pathlib import Path
from typing import Literal
from uuid import UUID

# Put the repo root on sys.path so `engine` and `api._lib` import the same way
# under uvicorn locally and inside the Vercel function bundle.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException, Query, Response  # noqa: E402

import engine  # noqa: E402
from api._lib import collect, demo, jobs, service  # noqa: E402
from api._lib.ai import AIUnavailable, LiveProvider, Provider, jobs_secret  # noqa: E402
from api._lib.evaluation import evaluate as run_evaluation  # noqa: E402
from api._lib.postgrest import Supabase  # noqa: E402
from api._lib.repo import Conflict, NotFound, Repository, SupabaseRepo  # noqa: E402
from api._lib.schemas import CollectTokenIn, CollectUploadIn, DemoStepIn, EvaluateIn, ReviewIn, SubmissionIn  # noqa: E402
from api._lib.settings import get_settings  # noqa: E402

app = FastAPI(
    title="Field QA Copilot API",
    version=engine.__version__,
    docs_url="/api/py/docs",
    openapi_url="/api/py/openapi.json",
)
router = APIRouter(prefix="/api/py")
_repo: Repository | None = None
_provider: Provider | None = None
HARD_EVAL = ROOT / "data" / "eval" / "hard.json"
# The numbers /architecture and /pitch show, all generated: evaluate.py (headline.json, hard.json) and
# measure.py (measurements.json, production timings). Committed, so the pages never show a typed number.
STORY_FILES = {"headline": ROOT / "data" / "eval" / "headline.json", "hard": HARD_EVAL,
               "measured": ROOT / "data" / "eval" / "measurements.json"}


def get_repo() -> Repository:
    global _repo
    if _repo is None:
        settings = get_settings()
        if not settings.supabase_url or not settings.service_key:
            raise HTTPException(503, "database is not configured")
        _repo = SupabaseRepo(Supabase(settings.supabase_url, settings.service_key, timeout=settings.db_timeout),
                             settings.project_id)
    return _repo


def get_provider() -> Provider:
    global _provider
    if _provider is None:
        settings = get_settings()
        _provider = LiveProvider(settings.anthropic_key, settings.elevenlabs_key)
    return _provider


def writes_value() -> bool:
    return get_settings().writes_enabled


READ_ONLY = "this deployment is a read-only preview: writes, demo controls and AI jobs run on production only"


def require_writes(enabled: bool = Depends(writes_value)) -> None:
    """Every credentialed route depends on this, so a preview deployment cannot write or spend."""
    if not enabled:
        raise HTTPException(403, READ_ONLY)


def jobs_secret_value() -> str | None:
    key = get_settings().service_key
    return jobs_secret(key) if key else None


def require_jobs_secret(_: None = Depends(require_writes), x_jobs_secret: str | None = Header(default=None),
                        expected: str | None = Depends(jobs_secret_value)) -> None:
    """The database's job hook (pg_net) sends this; it is derived from the service key."""
    if not expected or not x_jobs_secret or not hmac.compare_digest(x_jobs_secret, expected):
        raise HTTPException(401, "missing or wrong X-Jobs-Secret")


def passcode_value() -> str | None:
    return get_settings().demo_passcode


def require_passcode(_: None = Depends(require_writes), x_demo_passcode: str | None = Header(default=None),
                     expected: str | None = Depends(passcode_value)) -> None:
    if not expected:
        raise HTTPException(503, "writes are disabled: DEMO_PASSCODE is not set")
    if not x_demo_passcode or not hmac.compare_digest(x_demo_passcode, expected):
        raise HTTPException(401, "missing or wrong X-Demo-Passcode")


def collect_key() -> bytes | None:
    key = get_settings().service_key
    return collect.secret(key) if key else None


def require_phone(_: None = Depends(require_writes),
                  x_demo_passcode: str | None = Header(default=None), x_collect_token: str | None = Header(default=None),
                  expected: str | None = Depends(passcode_value), key: bytes | None = Depends(collect_key),
                  repo: Repository = Depends(get_repo)) -> dict:
    """The collect page's access: the passcode, or a collect token (QR code) that is signed, unexpired and
    from the current demo run. Returns who is writing, so token holders can be held to phone-shaped writes."""
    if x_demo_passcode and expected and hmac.compare_digest(x_demo_passcode, expected):
        return {"via": "passcode", "expires_at": None}
    if x_collect_token and key:
        try:
            expires = collect.verify(key, x_collect_token, (repo.clock() or {}).get("demo_run_id"))
        except collect.Refused as refused:
            raise HTTPException(401, str(refused))
        return {"via": "token", "expires_at": expires}
    raise HTTPException(401, "scan the QR code from the demo panel, or enter the demo passcode")


@router.get("/health")
def health(writes: bool = Depends(writes_value)) -> dict:
    return {"ok": True, "engine_version": engine.__version__, "writes": writes, "commit": get_settings().commit}


@router.post("/submissions", status_code=201)
def post_submission(payload: SubmissionIn, response: Response, repo: Repository = Depends(get_repo),
                    writer: dict = Depends(require_phone)) -> dict:
    """Store a phone's submission and score it, plus every earlier submission it affects.

    Idempotent on client_submission_id: a retry returns the stored record with 200,
    and finishes scoring first if an earlier attempt stored it but failed before
    writing results (`healed: true`). `changed` lists earlier submissions whose
    flagged status flipped because of this arrival. Needs the passcode, or a
    collect token (then only live submissions with the phone's own voice note).
    """
    if writer["via"] == "token":
        if payload.source != "live":
            raise HTTPException(403, "a collect token can only send live submissions")
        if payload.voice_note_path and not payload.voice_note_path.startswith(f"live/{payload.device_id}/"):
            raise HTTPException(403, "voice_note_path must be this phone's own upload")
    try:
        status, body = service.ingest(repo, payload)
    except service.UnknownContributor as error:
        raise HTTPException(422, f"unknown contributor code: {error}")
    except service.Busy:
        raise HTTPException(503, "another arrival for this contributor or device is being scored; retry",
                            headers={"Retry-After": "1"})
    except service.ScoringIncomplete:
        raise HTTPException(503, "stored, but scoring did not finish; retry with the same client_submission_id",
                            headers={"Retry-After": "1"})
    response.status_code = status
    return body


@router.get("/submissions/{submission_id}")
def get_submission(submission_id: UUID, repo: Repository = Depends(get_repo)) -> dict:
    detail = service.submission_detail(repo, str(submission_id))
    if detail is None:
        raise HTTPException(404, "submission not found")
    return detail


@router.get("/queue")
def get_queue(status: Literal["pending", "decided", "all"] = "pending",
              contributor: str | None = Query(default=None, description="contributor code, e.g. E07"),
              band: Literal["flagged", "watch"] = "flagged",
              limit: int = Query(default=50, ge=1, le=500),
              repo: Repository = Depends(get_repo)) -> dict:
    """Flagged (score >= review threshold) or watch-band submissions, highest score first.

    ai_pending marks items a model job (transcription, meaning check) is still working on.
    """
    out = service.queue(repo, status, contributor, band, limit)
    pending = {j["submission_id"] for j in repo.pending_jobs() if j.get("submission_id")}
    for item in out["items"]:
        item["ai_pending"] = item["submission_id"] in pending
    return out


@router.post("/reviews", status_code=201, dependencies=[Depends(require_passcode)])
def post_review(body: ReviewIn, repo: Repository = Depends(get_repo)) -> dict:
    try:
        return service.create_review(repo, body)
    except LookupError:
        raise HTTPException(404, "submission not found")
    except Conflict:
        raise HTTPException(409, "this submission already has an active decision; undo it first")


@router.delete("/reviews/{review_id}", dependencies=[Depends(require_passcode)])
def delete_review(review_id: UUID, repo: Repository = Depends(get_repo)) -> dict:
    """Undo a decision. The row is kept with revoked_at set."""
    try:
        return repo.revoke_review(str(review_id))
    except NotFound:
        raise HTTPException(404, "no active review with that id")


@router.get("/overview")
def get_overview(day: date | None = Query(default=None, alias="date",
                                         description="day for the 'yesterday' block; default is yesterday locally"),
                 repo: Repository = Depends(get_repo)) -> dict:
    return service.overview(repo, day)


@router.get("/map")
def get_map(repo: Repository = Depends(get_repo)) -> dict:
    """Points (id, contributor, position, score, band, fired checks, time), area polygons and hotspots."""
    return service.map_view(repo)


@router.post("/evaluate")
def post_evaluate(body: EvaluateIn, repo: Repository = Depends(get_repo)) -> dict:
    """Rescore the synthetic wave in memory with candidate params; aggregates only. Cached."""
    try:
        return run_evaluation(repo, body.params, body.sweep)
    except ValueError as error:
        raise HTTPException(422, str(error))


@router.post("/rescore", dependencies=[Depends(require_passcode)])
def post_rescore(repo: Repository = Depends(get_repo)) -> dict:
    """Rescore the whole project with the current check_config. A safety net."""
    return service.rescore(repo)


@router.get("/landing")
def get_landing(response: Response, repo: Repository = Depends(get_repo)) -> dict:
    """The landing page's stage: yesterday's scored submissions to replay, and the wave's /evaluate counters."""
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
    combined = run_evaluation(repo, {})["combined"]
    return {**service.replay_day(repo), "counters": {
        k: combined[k] for k in ("submissions", "fabricated", "flagged", "precision", "recall")}}


# Demo controls: the presenter's panel in the dashboard. All need the passcode.

@router.get("/demo/status", dependencies=[Depends(require_passcode)])
def get_demo_status(repo: Repository = Depends(get_repo)) -> dict:
    """Live-day progress (sent, total, field clock, next sync) and the key moments with their field times."""
    return demo.status(repo)


@router.post("/demo/step", dependencies=[Depends(require_passcode)])
def post_demo_step(body: DemoStepIn, repo: Repository = Depends(get_repo)) -> dict:
    """Send the next pending live-day submissions through the same ingest as POST /submissions.

    Pending means not in the database yet (by client_submission_id), so repeating
    a step, or two tabs stepping at once, never sends anything twice.
    """
    try:
        return demo.step(repo, str(body.run_id), body.count, body.until_field_time)
    except demo.StaleRun:
        raise HTTPException(409, "this demo run was reset; reload the demo controls to get the new run")


@router.post("/demo/reset", dependencies=[Depends(require_passcode)])
def post_demo_reset(repo: Repository = Depends(get_repo)) -> dict:
    """Delete simulator and live submissions (with their results, reviews and labels) and every review,
    rescore the wave (only changed rows are written), and set the project clock back to Oct 31, 08:00."""
    return demo.reset(repo)


# The phone collect page ----------------------------------------------------------------

@router.post("/collect/token", dependencies=[Depends(require_passcode)])
def post_collect_token(body: CollectTokenIn, repo: Repository = Depends(get_repo),
                       key: bytes | None = Depends(collect_key)) -> dict:
    """A QR-code token for /collect: signed, expires (30 min by default), revoked by a demo reset."""
    run_id = (repo.clock() or {}).get("demo_run_id")
    if not key or not run_id:
        raise HTTPException(503, "collect tokens need the service key and a demo run (reset the demo once)")
    token, expires = collect.mint(key, str(run_id), body.ttl_seconds)
    return {"token": token, "expires_at": expires, "path": f"/collect?t={token}"}


@router.get("/collect/session")
def get_collect_session(writer: dict = Depends(require_phone), repo: Repository = Depends(get_repo)) -> dict:
    """What the phone needs: contributors with their areas and last interview spot, and the token's expiry."""
    return {"expires_at": writer["expires_at"], **service.collect_session(repo)}


@router.post("/collect/upload")
def post_collect_upload(body: CollectUploadIn, writer: dict = Depends(require_phone),
                        repo: Repository = Depends(get_repo)) -> dict:
    """A signed URL the phone PUTs its voice note to, at live/<device>/<client id>.<ext>; a retry gets the same path."""
    try:
        path = collect.voice_path(body.device_id, body.client_submission_id, body.content_type)
    except ValueError as error:
        raise HTTPException(422, str(error))
    return {"path": path, "upload_url": repo.signed_upload(collect.VOICE_BUCKET, path)}


# AI jobs ---------------------------------------------------------------------------

@router.post("/jobs/run", dependencies=[Depends(require_jobs_secret)])
def post_jobs_run(job_id: UUID = Body(embed=True), repo: Repository = Depends(get_repo),
                  provider: Provider = Depends(get_provider)) -> dict:
    """Run one queued job. Called by the database (pg_net) the moment a job is queued."""
    return jobs.run_job(repo, provider, job_id=str(job_id))


@router.post("/jobs/drain", dependencies=[Depends(require_passcode)])
def post_jobs_drain(limit: int = Query(default=10, ge=1, le=50), repo: Repository = Depends(get_repo),
                    provider: Provider = Depends(get_provider)) -> dict:
    """Safety net: run queued (or abandoned) jobs, oldest first."""
    return {"ran": jobs.drain(repo, provider, limit)}


@router.post("/jobs/{job_id}/rerun", dependencies=[Depends(require_passcode)])
def post_job_rerun(job_id: UUID, repo: Repository = Depends(get_repo)) -> dict:
    """Force a finished job to run again (the database hook picks it up)."""
    job = repo.requeue_job(str(job_id))
    if job is None:
        raise HTTPException(409, "no finished job with that id")
    return {"id": job["id"], "status": job["status"]}


# The morning brief ------------------------------------------------------------------

@router.get("/brief")
def get_brief(repo: Repository = Depends(get_repo), provider: Provider = Depends(get_provider),
              writes: bool = Depends(writes_value)) -> dict:
    """Today's brief (model-written, or the template fallback), the facts it was written from, and its state."""
    return jobs.brief_state(repo, provider, queue=writes)


@router.post("/brief/regenerate", dependencies=[Depends(require_passcode)])
def post_brief_regenerate(repo: Repository = Depends(get_repo)) -> dict:
    job = jobs.queue_brief(repo, force=True)
    return {"queued": job is not None, "job_id": job and job["id"]}


@router.post("/brief/{brief_id}/audio")
def post_brief_audio(brief_id: UUID, repo: Repository = Depends(get_repo),
                     provider: Provider = Depends(get_provider), writes: bool = Depends(writes_value)) -> dict:
    """The brief read aloud: a signed URL, synthesised on first use and cached in Storage."""
    try:
        return jobs.brief_audio(repo, provider, str(brief_id), synthesise=writes)
    except jobs.ReadOnly:
        raise HTTPException(403, READ_ONLY)
    except NotFound:
        raise HTTPException(404, "no model-written brief with that id")
    except jobs.SpeechOff as error:
        raise HTTPException(409, f"text to speech is off here: {error}")
    except AIUnavailable as error:
        raise HTTPException(503, f"text to speech is unavailable: {error}")


# Hard-mode evaluation (scripts/evaluate.py --hard) ------------------------------------

@router.get("/eval/hard")
def get_eval_hard(response: Response) -> dict:
    """Rules only vs rules + AI on the hard synthetic waves. Aggregates only."""
    if not HARD_EVAL.exists():
        raise HTTPException(404, "no hard-mode evaluation has been run yet")
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=600"
    return json.loads(HARD_EVAL.read_text())


@router.get("/story")
def get_story(response: Response, repo: Repository = Depends(get_repo)) -> dict:
    """Held-out headline, hard mode and production measurements, plus the model spend right now."""
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400"
    story = {name: json.loads(path.read_text()) if path.exists() else None for name, path in STORY_FILES.items()}
    try:
        story["spend_now"] = repo.ai_spend(None)
    except Exception:  # noqa: BLE001  the pages still render from the files
        story["spend_now"] = None
    return story


app.include_router(router)

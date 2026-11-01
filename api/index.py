"""FastAPI app. Deployed as a Vercel Python function; every route lives under /api/py.

Read endpoints are public. Write endpoints need the X-Demo-Passcode header.
"""

import hmac
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

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Response  # noqa: E402

import engine  # noqa: E402
from api._lib import service  # noqa: E402
from api._lib.evaluation import evaluate as run_evaluation  # noqa: E402
from api._lib.postgrest import Supabase  # noqa: E402
from api._lib.repo import Conflict, NotFound, Repository, SupabaseRepo  # noqa: E402
from api._lib.schemas import EvaluateIn, ReviewIn, SubmissionIn  # noqa: E402
from api._lib.settings import get_settings  # noqa: E402

app = FastAPI(
    title="Field QA Copilot API",
    version=engine.__version__,
    docs_url="/api/py/docs",
    openapi_url="/api/py/openapi.json",
)
router = APIRouter(prefix="/api/py")
_repo: Repository | None = None


def get_repo() -> Repository:
    global _repo
    if _repo is None:
        settings = get_settings()
        if not settings.supabase_url or not settings.service_key:
            raise HTTPException(503, "database is not configured")
        _repo = SupabaseRepo(Supabase(settings.supabase_url, settings.service_key, timeout=20), settings.project_id)
    return _repo


def passcode_value() -> str | None:
    return get_settings().demo_passcode


def require_passcode(x_demo_passcode: str | None = Header(default=None),
                     expected: str | None = Depends(passcode_value)) -> None:
    if not expected:
        raise HTTPException(503, "writes are disabled: DEMO_PASSCODE is not set")
    if not x_demo_passcode or not hmac.compare_digest(x_demo_passcode, expected):
        raise HTTPException(401, "missing or wrong X-Demo-Passcode")


@router.get("/health")
def health() -> dict:
    return {"ok": True, "engine_version": engine.__version__}


@router.post("/submissions", status_code=201, dependencies=[Depends(require_passcode)])
def post_submission(payload: SubmissionIn, response: Response, repo: Repository = Depends(get_repo)) -> dict:
    """Store a phone's submission and score it, plus every earlier submission it affects.

    Idempotent on client_submission_id: a retry returns the stored record with 200,
    and finishes scoring first if an earlier attempt stored it but failed before
    writing results (`healed: true`). `changed` lists earlier submissions whose
    flagged status flipped because of this arrival.
    """
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
    """Flagged (score >= review threshold) or watch-band submissions, highest score first."""
    return service.queue(repo, status, contributor, band, limit)


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


app.include_router(router)

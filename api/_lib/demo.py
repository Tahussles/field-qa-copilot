"""Demo controls: put the project back to the fresh wave, and replay the seeded live day through ingest.

The live day comes from the generator (datagen.live), the same one
scripts/simulate.py replays. step() sends it through service.ingest, exactly
as POST /submissions does, then records the generator's labels for what it
sent (server-side; nothing reads them back here) and moves the project clock
(projects.as_of) forward to the latest field time sent.

"Pending" means a live-day submission whose client_submission_id is not in the
database yet, so a repeated or concurrent step never sends anything twice.
"""

import time
from datetime import datetime, timezone
from functools import lru_cache

from datagen import config as cfg
from datagen.live import LiveDay, api_payload, build_live_day

from . import service
from .repo import Repository
from .schemas import SubmissionIn

DEMO_SEED = 20261031
LIVE_SOURCES = ("simulator", "live")
RESET_AS_OF = cfg.PROJECT_AS_OF  # Oct 31, 08:00 in Kisumu
MAX_STEP = 50  # submissions per call, so one request stays well inside the function timeout
RETRIES = 6
BATCH_GAP_SECONDS = 120  # syncs from one phone closer than this are one batch

# How the demo narrates each planted fraud type's first arrival in the live day.
MOMENTS = {
    "curbstone": "tea-shop batch",
    "night": "night forms",
    "burst": "burst",
    "multi_account": "ring device activity",
    "contradiction": "contradiction",
    "copypaste": "copy",
    "speeder": "speeding",
}


@lru_cache(maxsize=2)
def live_day(seed: int = DEMO_SEED) -> LiveDay:
    return build_live_day(seed)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def key_moments(live: LiveDay) -> list[dict]:
    """The first arrival of each fraud actor in the live day, at the start of the sync batch it came in."""
    moments = []
    for fraud_type, label in MOMENTS.items():
        fakes = [s for s in live.submissions if s.fraud_type == fraud_type]
        if not fakes:
            continue
        first = fakes[0]
        ring = fraud_type == "multi_account"
        same_phone = [s for s in live.submissions
                      if (s.device_id == first.device_id if ring else s.contributor.code == first.contributor.code)]
        start = same_phone.index(first)
        while start > 0 and (same_phone[start].synced_at - same_phone[start - 1].synced_at).total_seconds() <= BATCH_GAP_SECONDS:
            start -= 1
        opener = same_phone[start]
        codes = sorted({s.contributor.code for s in fakes})
        moments.append({
            "key": fraud_type,
            "label": label.capitalize() if ring else f"{first.contributor.code} {label}",
            "codes": codes,
            "field_time": _iso(opener.synced_at),
            "client_submission_id": opener.client_submission_id,
            "submissions": len(fakes),
        })
    return sorted(moments, key=lambda m: m["field_time"])


def progress(repo: Repository, live: LiveDay, present: dict[str, str] | None = None) -> dict:
    present = repo.client_ids(LIVE_SOURCES) if present is None else present
    sent_ids = [present[s.client_submission_id] for s in live.submissions if s.client_submission_id in present]
    pending = next((s for s in live.submissions if s.client_submission_id not in present), None)
    flagged = sum(row["flagged"] for row in repo.scores(sent_ids)) if sent_ids else 0
    return {
        "sent": len(sent_ids),
        "total": len(live.submissions),
        "flagged": flagged,
        "field_clock": repo.as_of(),
        "next_field_time": _iso(pending.synced_at) if pending else None,
        "done": pending is None,
    }


def status(repo: Repository, seed: int = DEMO_SEED) -> dict:
    live = live_day(seed)
    present = repo.client_ids(LIVE_SOURCES)
    moments = [{**m, "sent": m["client_submission_id"] in present} for m in key_moments(live)]
    return {"seed": seed, "progress": progress(repo, live, present), "moments": moments}


def _ingest_with_retry(repo: Repository, body: SubmissionIn) -> tuple[int, dict]:
    """Like a phone: a busy lease or an unfinished score is retried with the same client id."""
    for attempt in range(RETRIES):
        try:
            return service.ingest(repo, body)
        except (service.Busy, service.ScoringIncomplete):
            if attempt == RETRIES - 1:
                raise
            time.sleep(0.25 * (attempt + 1))
    raise AssertionError("unreachable")


def step(repo: Repository, count: int | None = None, until: datetime | None = None, seed: int = DEMO_SEED) -> dict:
    """Send the next pending live-day submissions in sync order: `count` of them, or all synced by `until`."""
    started = time.perf_counter()
    live = live_day(seed)
    present = repo.client_ids(LIVE_SOURCES)
    due = [s for s in live.submissions if s.client_submission_id not in present]
    if until is not None:
        due = [s for s in due if s.synced_at <= until]
    limit = min(count if count is not None else (MAX_STEP if until is not None else 1), MAX_STEP)
    due = due[:limit]

    results, labels, error = [], [], None
    latest: datetime | None = None
    try:
        for sub in due:
            try:
                code, body = _ingest_with_retry(repo, SubmissionIn(**api_payload(sub)))
            except (service.Busy, service.ScoringIncomplete) as failure:
                error = f"{sub.contributor.code} could not be scored yet ({type(failure).__name__}); step again"
                break  # later submissions must not overtake this one
            present[sub.client_submission_id] = body["id"]
            labels.append({"submission_id": body["id"], "is_fabricated": sub.is_fabricated,
                           "fraud_type": sub.fraud_type, "noise_tag": sub.noise_tag})
            latest = sub.synced_at
            results.append({
                "id": body["id"],
                "code": sub.contributor.code,
                "field_time": _iso(sub.synced_at),
                "captured_at": body["captured_at"],
                "score": body["score"],
                "band": body["band"],
                "flagged": body["flagged"],
                "fired": [f["key"] for f in body["fired"]],
                "changed": [{"submission_id": c["submission_id"], "flagged": c["flagged"]} for c in body["changed"]],
                "duplicate": code == 200,
            })
    finally:
        if repo.write_truth(labels) < len(labels):
            # A reset ran while this step was sending: its rows are gone, so leave the clock alone.
            error = "the demo was reset while this step ran; it stopped"
        elif latest is not None:
            repo.set_as_of(_iso(latest), forward_only=True)
    return {
        "results": results,
        "error": error,
        "progress": progress(repo, live, present),
        "timing_ms": round((time.perf_counter() - started) * 1000),
    }


def reset(repo: Repository) -> dict:
    """Delete the live day and every review, rescore what is left (quiet: only changed rows), rewind the clock."""
    started = time.perf_counter()
    deleted = repo.delete_submissions(LIVE_SOURCES)
    deleted["reviews"] += repo.delete_reviews()
    rescored = service.rescore(repo)
    repo.set_as_of(RESET_AS_OF)
    return {
        "deleted": deleted,
        "rescored": {k: rescored[k] for k in ("submissions", "flagged", "rows_written")},
        "as_of": repo.as_of(),
        "timing_ms": round((time.perf_counter() - started) * 1000),
    }

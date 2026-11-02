"""AI jobs: queue model work, run it, store the verdicts, rescore through the normal incremental path.

ai_jobs drives everything (queued -> running -> done | failed). A new job is
POSTed to /api/py/jobs/run by the database itself (pg_net, migration 0007), so it
starts within about a second without the arrival waiting; /api/py/jobs/drain is
the safety net. dedupe_key makes queueing idempotent, and a claimed job is
never run twice unless it is re-queued on purpose.

A failed model call never changes a score: with no verdict, the rule stands.
"""

import hashlib
import json
import logging
import time

from engine.textsim import SIMILARITY, shingle_jaccard

from . import brief as briefs
from . import service
from .ai import AIUnavailable, BriefOut, Provider, Usage
from .repo import NotFound, Repository

log = logging.getLogger(__name__)

# Reworded copies: a cheap, wide filter first, then the model on what passes it.
PARAPHRASE_SHINGLE_MIN = 0.45
PARAPHRASE_PAIRS_PER_ARRIVAL = 3  # bounds model calls per submission, so per contributor per day
RESCORE_TRIES = 5
AUDIO_BUCKET = "voice-notes"
BRIEF_AUDIO_BUCKET = "brief-audio"
BRIEF_AUDIO_SECONDS = 3600


def _hash(*parts) -> str:
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:12]


def _open_text(row: dict) -> str:
    return ((row.get("answers") or {}).get("open_text") or "").strip()


# What to queue --------------------------------------------------------------------------

def transcribe_job(row: dict) -> dict | None:
    path = row.get("voice_note_path")
    if not path or row.get("voice_transcript"):
        return None
    return {"kind": "transcribe", "submission_id": row["id"], "dedupe_key": f"transcribe:{row['id']}:{path}",
            "input": {"path": path}}


def consistency_job(row: dict, notify: bool = True) -> dict | None:
    transcript = row.get("voice_transcript")
    source = (row.get("answers") or {}).get("water_source")
    if not transcript or not source:
        return None
    version = _hash(transcript, source, _open_text(row))
    return {"kind": "consistency", "submission_id": row["id"], "notify": notify,
            "dedupe_key": f"consistency:{row['id']}:{version}", "input": {"version": version}}


def paraphrase_candidates(row: dict, others: list[dict], params, limit: int) -> list[dict]:
    """Pairs worth asking the model about: char-shingle similarity >= 0.45 but below the copy threshold."""
    text = _open_text(row)
    if not text:
        return []
    rule = SIMILARITY[params.copy_method]
    found = []
    for other in others:
        other_text = _open_text(other)
        if other["id"] == row["id"] or not other_text:
            continue
        similarity = shingle_jaccard(text, other_text)
        if similarity >= PARAPHRASE_SHINGLE_MIN and rule(text, other_text) < params.copy_similarity - 1e-9:
            found.append({"other_id": other["id"], "similarity": round(similarity, 3)})
    found.sort(key=lambda c: (-c["similarity"], c["other_id"]))
    return found[:limit]


def paraphrase_job(row: dict, pairs: list[dict], notify: bool = True) -> dict | None:
    if not pairs:
        return None
    return {"kind": "paraphrase", "submission_id": row["id"], "notify": notify,
            "dedupe_key": f"paraphrase:{row['id']}:{_hash(sorted(p['other_id'] for p in pairs), _open_text(row))}",
            "input": {"pairs": pairs}}


def queue_for_arrival(repo: Repository, ctx, row: dict, group: list[dict]) -> list[dict]:
    """Queue the model work an arrival needs. Never raises: ingest must not fail because of AI."""
    try:
        others = [g for g in group if g["id"] != row["id"] and (
            g["contributor_id"] == row["contributor_id"] or (row.get("device_id") and g.get("device_id") == row["device_id"]))]
        wanted = [transcribe_job(row), consistency_job(row),
                  paraphrase_job(row, paraphrase_candidates(row, others, ctx.params, PARAPHRASE_PAIRS_PER_ARRIVAL))]
        return [{"id": j["id"], "kind": j["kind"]} for j in repo.queue_jobs([j for j in wanted if j])]
    except Exception:  # noqa: BLE001
        log.exception("could not queue AI jobs for %s", row.get("id"))
        return []


# Running --------------------------------------------------------------------------------

def _usage_fields(usage: Usage | None) -> dict:
    if usage is None:
        return {}
    return {"model": usage.model, "input_tokens": usage.input_tokens, "output_tokens": usage.output_tokens,
            "latency_ms": usage.latency_ms, "cost_usd": usage.cost_usd}


def _rescore(repo: Repository, submission_id: str) -> dict:
    """The normal incremental path, retried while another arrival holds the group's lease."""
    for attempt in range(RESCORE_TRIES):
        try:
            return service.rescore_submission(repo, submission_id)
        except (service.Busy, service.ScoringIncomplete):
            time.sleep(0.4 * (attempt + 1))
    return {"submission_id": submission_id, "error": "the group stayed busy; the next arrival or rescore applies it"}


def _submission(repo: Repository, submission_id: str) -> dict:
    row = repo.submission(submission_id)
    if row is None:
        raise NotFound(submission_id)
    return row


def run_consistency(repo, provider: Provider, job):
    row = _submission(repo, job["submission_id"])
    verdict, usage = provider.judge_consistency(row["answers"]["water_source"], _open_text(row), row["voice_transcript"])
    data = {**verdict.model_dump(), "latency_ms": usage.latency_ms}
    repo.put_verdict({"submission_id": row["id"], "kind": "voice_vs_form", "model": usage.model, "verdict": data})
    return {"verdict": data, "rescore": _rescore(repo, row["id"])}, usage


def run_paraphrase(repo, provider: Provider, job):
    row = _submission(repo, job["submission_id"])
    text = _open_text(row)
    total, judged, errors = None, [], []
    for pair in job["input"]["pairs"]:
        other = repo.submission(pair["other_id"])
        if other is None:
            continue
        try:
            verdict, usage = provider.judge_paraphrase(_open_text(other), text)
        except AIUnavailable as error:
            errors.append(str(error))
            total = error.usage if total is None else total.add(error.usage or Usage(""))
            continue
        total = usage if total is None else total.add(usage)
        data = {**verdict.model_dump(), "similarity": pair["similarity"], "latency_ms": usage.latency_ms}
        repo.put_verdict({"submission_id": row["id"], "pair_submission_id": other["id"], "kind": "paraphrase",
                          "model": usage.model, "verdict": data})
        judged.append({"other_id": other["id"], **data})
    if errors and not judged:
        raise AIUnavailable("; ".join(errors), total)
    return {"pairs": judged, "errors": errors, "rescore": _rescore(repo, row["id"]) if judged else None}, total


def run_transcribe(repo, provider: Provider, job):
    row = _submission(repo, job["submission_id"])
    audio = repo.download(AUDIO_BUCKET, job["input"]["path"])
    text, language, usage = provider.transcribe(audio, job["input"]["path"].rsplit("/", 1)[-1])
    repo.set_transcript(row["id"], text, language or None)
    row = {**row, "voice_transcript": text, "transcript_lang": language}
    rescore = _rescore(repo, row["id"])  # the keyword rule now has a transcript to read
    queued = repo.queue_jobs([j for j in [consistency_job(row)] if j])
    return {"transcript": text, "language": language, "rescore": rescore,
            "queued": [{"id": j["id"], "kind": j["kind"]} for j in queued]}, usage


def run_brief(repo, provider: Provider, job):
    facts, for_date, version = job["input"]["facts"], job["input"]["for_date"], job["input"]["data_version"]
    try:
        written, usage = provider.write_brief(facts, lambda b: briefs.check(b, facts))
    except AIUnavailable as error:
        saved = repo.save_brief({"for_date": for_date, "data_version": version, "status": "template",
                                 "stats": facts, "items": None, "content_md": None, "model": None,
                                 "fallback": {"reason": str(error)}})
        return {"brief_id": saved["id"], "status": "template", "reason": str(error)}, error.usage
    saved = repo.save_brief({"for_date": for_date, "data_version": version, "status": "ai", "stats": facts,
                             "items": written.model_dump(), "content_md": briefs.markdown(written),
                             "model": usage.model, "fallback": None})
    return {"brief_id": saved["id"], "status": "ai", "rejected": usage.rejected}, usage


def run_tts(repo, provider: Provider, job):
    saved = repo.brief(job["input"]["brief_id"])
    if saved is None or saved["status"] != "ai":
        raise NotFound(job["input"]["brief_id"])
    audio, usage = provider.speak(briefs.speech(BriefOut.model_validate(saved["items"])))
    path = f"{saved['id']}.mp3"
    repo.upload(BRIEF_AUDIO_BUCKET, path, audio, "audio/mpeg")
    repo.set_brief_audio(saved["id"], path)
    return {"path": path, "bytes": len(audio)}, usage


HANDLERS = {"consistency": run_consistency, "paraphrase": run_paraphrase, "transcribe": run_transcribe,
            "brief": run_brief, "tts": run_tts}


def run_job(repo: Repository, provider: Provider, job_id: str | None = None, job: dict | None = None) -> dict:
    """Claim (unless given a claimed job) and run one job, recording what it cost. Never raises."""
    job = job or repo.claim_job(job_id)
    if job is None:
        return {"job_id": job_id, "status": "skipped", "reason": "not queued (already running or finished)"}
    started = time.perf_counter()
    try:
        output, usage = HANDLERS[job["kind"]](repo, provider, job)
        values = {"status": "done", "output": output, **_usage_fields(usage)}
    except AIUnavailable as error:
        values = {"status": "failed", "error": str(error)[:500], **_usage_fields(error.usage)}
    except (NotFound, LookupError) as error:
        values = {"status": "failed", "error": f"gone: {error}"[:500]}
    except Exception as error:  # noqa: BLE001  a job failure must not take the worker down
        log.exception("job %s failed", job["id"])
        values = {"status": "failed", "error": f"{type(error).__name__}: {error}"[:500]}
    repo.finish_job(job["id"], values)
    return {"job_id": job["id"], "kind": job["kind"], "status": values["status"], "error": values.get("error"),
            "wall_ms": round((time.perf_counter() - started) * 1000), **{k: values.get(k) for k in ("model", "cost_usd")}}


def drain(repo: Repository, provider: Provider, limit: int = 10) -> list[dict]:
    """Run whatever is queued (or abandoned), oldest first: the safety net behind the database hook."""
    return [run_job(repo, provider, job=job) for job in repo.claim_jobs(limit)]


# The brief ----------------------------------------------------------------------------------

def _brief_inputs(repo: Repository) -> tuple[str, dict, str]:
    overview = service.overview(repo)
    facts = briefs.facts(overview)
    return overview["today"]["date"], facts, briefs.data_version(facts)


def queue_brief(repo: Repository, force: bool = False) -> dict | None:
    """Queue a brief for today's numbers. force re-runs a finished job for the same numbers."""
    for_date, facts, version = _brief_inputs(repo)
    key = f"brief:{for_date}:{version}"
    new = repo.queue_jobs([{"kind": "brief", "dedupe_key": key,
                            "input": {"for_date": for_date, "facts": facts, "data_version": version}}])
    if new:
        return new[0]
    if force:
        existing = repo.job_by_key(key)
        if existing and existing["status"] in ("queued", "running"):
            return existing
        return repo.requeue_job(existing["id"]) if existing else None
    return None


def brief_state(repo: Repository) -> dict:
    """The newest brief for today, whether it matches today's numbers, and whether one is being written.

    The first visit of the day queues one; after that only Regenerate does, so a
    busy demo does not pay for a new brief on every arrival.
    """
    for_date, facts, version = _brief_inputs(repo)
    rows = repo.briefs(for_date)
    writing = any(j["kind"] == "brief" for j in repo.pending_jobs())
    if not rows and not writing:
        writing = queue_brief(repo) is not None or writing
    latest = rows[0] if rows else None
    return {
        "for_date": for_date,
        "data_version": version,
        "facts": facts,
        "brief": latest and {k: latest.get(k) for k in (
            "id", "status", "items", "content_md", "model", "stats", "fallback", "data_version", "created_at")}
        | {"has_audio": bool(latest.get("audio_path"))},
        "stale": bool(latest and latest["data_version"] != version),
        "writing": writing,
    }


def brief_audio(repo: Repository, provider: Provider, brief_id: str) -> dict:
    """A signed URL for the brief read aloud, synthesising it the first time (cached in Storage)."""
    saved = repo.brief(brief_id)
    if saved is None or saved["status"] != "ai":
        raise NotFound(brief_id)
    if not saved.get("audio_path"):
        key = f"tts:{brief_id}"
        new = repo.queue_jobs([{"kind": "tts", "notify": False, "dedupe_key": key, "input": {"brief_id": brief_id}}])
        job = new[0] if new else repo.job_by_key(key)
        if job is not None and job["status"] in ("done", "failed"):
            job = repo.requeue_job(job["id"])  # done without audio means the file went missing
        if job is not None and job["status"] == "queued":
            result = run_job(repo, provider, job_id=job["id"])
            if result["status"] != "done":
                raise AIUnavailable(result.get("error") or "text to speech failed")
        saved = repo.brief(brief_id)
        if not saved.get("audio_path"):
            raise AIUnavailable("the audio is still being made; try again in a moment")
    return {"url": repo.signed_url(BRIEF_AUDIO_BUCKET, saved["audio_path"], BRIEF_AUDIO_SECONDS)}

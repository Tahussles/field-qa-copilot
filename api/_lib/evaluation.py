"""POST /evaluate: rescore the synthetic wave with candidate params and compare with ground truth.

The only API code that reads the ground truth. It stays server-side: responses
carry aggregates only (counts, precision, recall), never submission ids or
per-row labels.

Results are cached per (params, engine_version, data version). The data
version is the synthetic row count plus the latest synced_at, and the verdict
count plus the latest verdict, so new or deleted data (or a model verdict
landing) invalidates both the cached dataset and the cached results. Scoring
reads the stored verdicts, as production does.
"""

import json
import threading
import time
from collections import OrderedDict
from dataclasses import replace

from engine import Params, Submission, __version__, score_all
from engine.metrics import combined, per_check

from .repo import Repository
from .service import context, verdict_index

SWEEP_THRESHOLDS = tuple(1.0 + 0.5 * i for i in range(15))  # 1.0 to 8.0
RESULT_CACHE_SIZE = 64
VERSION_TTL_SECONDS = 5.0

_lock = threading.Lock()


def _state(repo: Repository) -> dict:
    return repo.__dict__.setdefault("_evaluation_state", {
        "version": None, "version_checked": 0.0, "dataset": None, "dataset_version": None,
        "results": OrderedDict(),
    })


def _data_version(repo: Repository, state: dict) -> tuple:
    ttl = VERSION_TTL_SECONDS if getattr(repo, "cache_ttl", 0) else 0
    if state["version"] is None or time.monotonic() - state["version_checked"] > ttl:
        state["version"] = (*repo.data_version("synthetic"), *repo.verdict_version())
        state["version_checked"] = time.monotonic()
    return state["version"]


def _dataset(repo: Repository, state: dict, version: tuple):
    if state["dataset_version"] != version:
        submissions = [Submission.from_row(r) for r in repo.submissions(source="synthetic")]
        labels = repo.truth_labels()
        verdicts = verdict_index([v for v in repo.verdicts() if v["submission_id"] in labels])
        state["dataset"] = ([s for s in submissions if s.id in labels], labels, verdicts)
        state["dataset_version"] = version
    return state["dataset"]


def evaluate(repo: Repository, overrides: dict, sweep: bool = False) -> dict:
    started = time.perf_counter()
    ctx = context(repo)
    merged = ctx.params.to_config()
    for key, value in overrides.items():
        merged[key] = {**merged[key], **value} if isinstance(merged.get(key), dict) and isinstance(value, dict) else value
    params = replace(Params.from_config(merged), timezone=ctx.params.timezone)

    with _lock:
        state = _state(repo)
        version = _data_version(repo, state)
        key = (json.dumps(params.to_dict(), sort_keys=True), __version__, version, sweep)
        cached = state["results"].get(key)
        if cached is not None:
            state["results"].move_to_end(key)
            return {**cached, "cached": True,
                    "timing_ms": {"total": round((time.perf_counter() - started) * 1000)}}
        submissions, labels, verdicts = _dataset(repo, state, version)

    loaded = time.perf_counter()
    scored = score_all(submissions, ctx.contributors, params, verdicts)
    scores = {s.submission_id: s.score for s in scored}
    result = {
        "engine_version": __version__,
        "params": params.to_config(),
        "data_version": {"rows": version[0], "latest_synced_at": version[1], "verdicts": version[2]},
        "combined": combined(scores, labels, params.review_threshold, params.watch_threshold),
        "per_check": per_check(scored, labels),
    }
    if sweep:
        result["sweep"] = [
            {k: v for k, v in combined(scores, labels, threshold).items() if k in ("threshold", "precision", "recall", "flagged")}
            for threshold in SWEEP_THRESHOLDS
        ]
    with _lock:
        state["results"][key] = result
        while len(state["results"]) > RESULT_CACHE_SIZE:
            state["results"].popitem(last=False)
    return {**result, "cached": False, "timing_ms": {
        "load": round((loaded - started) * 1000),
        "score": round((time.perf_counter() - loaded) * 1000),
        "total": round((time.perf_counter() - started) * 1000),
    }}

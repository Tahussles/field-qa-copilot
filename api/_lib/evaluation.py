"""POST /evaluate: rescore the synthetic wave with candidate params and compare with ground truth.

The only API code that reads the ground truth. It stays server-side: responses
carry aggregates only (counts, precision, recall), never submission ids or
per-row labels.
"""

import time
from dataclasses import replace

from engine import Params, Submission, __version__, score_all
from engine.metrics import combined, per_check

from .repo import Repository
from .service import _cached, context


def _dataset(repo: Repository):
    def load():
        submissions = [Submission.from_row(r) for r in repo.submissions(source="synthetic")]
        labels = repo.truth_labels()
        return [s for s in submissions if s.id in labels], labels
    return _cached(repo, "synthetic_dataset", load)


def evaluate(repo: Repository, overrides: dict) -> dict:
    started = time.perf_counter()
    ctx = context(repo)
    merged = ctx.params.to_config()
    for key, value in overrides.items():
        merged[key] = {**merged[key], **value} if isinstance(merged.get(key), dict) and isinstance(value, dict) else value
    params = replace(Params.from_config(merged), timezone=ctx.params.timezone)

    submissions, labels = _dataset(repo)
    loaded = time.perf_counter()
    scored = score_all(submissions, ctx.contributors, params)
    scores = {s.submission_id: s.score for s in scored}
    summary = combined(scores, labels, params.review_threshold, params.watch_threshold)
    return {
        "engine_version": __version__,
        "params": params.to_config(),
        "combined": summary,
        "per_check": per_check(scored, labels),
        "timing_ms": {
            "load": round((loaded - started) * 1000),
            "score": round((time.perf_counter() - loaded) * 1000),
        },
    }

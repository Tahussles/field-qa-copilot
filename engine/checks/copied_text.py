"""copied_text: open_text copies another submission by the same contributor or device.

Two deciders, recorded as decided_by:

- rules: a near-duplicate by params.copy_method at or above params.copy_similarity.
- ai_paraphrase: no near-duplicate, but a stored model verdict (kind paraphrase)
  says the two answers are a reworded copy of the same answer. The model is only
  asked about pairs the shingle filter already found similar (see api/_lib/jobs.py).
  This weighs params.ai_paraphrase_weight (1.5), below the review threshold:
  corroboration for other checks, never a flag on its own.
"""

from ..model import CheckResult, Context, Submission
from ..textsim import SIMILARITY, content_words

KEY = "copied_text"
_TOP_MATCHES = 5


def _open_text(sub: Submission) -> str:
    return (sub.answers.get("open_text") or "").strip()


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    weight = params.weights[KEY]
    text = _open_text(target)
    if not text:
        return CheckResult(KEY, False, weight, {"missing": "open_text"})

    candidates: dict[str, tuple[Submission, str]] = {}
    for other in ctx.same_contributor:
        candidates[other.id] = (other, "same_contributor")
    for other in ctx.same_device:
        candidates.setdefault(other.id, (other, "same_device"))

    similarity = SIMILARITY[params.copy_method]
    scored = []
    for other, relation in candidates.values():
        other_text = _open_text(other)
        if other_text:
            scored.append((similarity(text, other_text), other, relation))
    scored.sort(key=lambda m: (-m[0], m[1].id))
    matches = [m for m in scored if m[0] >= params.copy_similarity - 1e-9]

    best = None
    if scored:
        value, other, relation = scored[0]
        best = {
            "submission_id": other.id,
            "similarity": round(value, 3),
            "relation": relation,
            "shared_words": sorted(content_words(text) & content_words(_open_text(other))),
        }
    reworded = [
        (v, candidates[v.other_id][0], candidates[v.other_id][1])
        for v in sorted(ctx.verdicts, key=lambda v: v.other_id or "")
        if v.kind == "paraphrase" and v.data.get("reworded") and v.other_id in candidates
    ]
    decided_by = "rules" if matches else "ai_paraphrase" if reworded else None
    if decided_by == "ai_paraphrase":
        weight = params.ai_paraphrase_weight  # corroboration only: a model's word alone never sends to review
    return CheckResult(KEY, bool(matches) or bool(reworded), weight, {
        "decided_by": decided_by,
        "paraphrases": [
            {"submission_id": other.id, "relation": relation, "model": v.model, "reason": v.data.get("reason"),
             "similarity": v.data.get("similarity"), "other_text": _open_text(other), "latency_ms": v.data.get("latency_ms")}
            for v, other, relation in reworded[:_TOP_MATCHES]
        ],
        "method": params.copy_method,
        "threshold": params.copy_similarity,
        "match_count": len(matches),
        "best_match": best,
        "matches": [
            {"submission_id": other.id, "similarity": round(value, 3), "relation": relation}
            for value, other, relation in matches[:_TOP_MATCHES]
        ],
    })

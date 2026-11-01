"""copied_text: open_text is a near-duplicate of another submission by the same contributor or device."""

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
    return CheckResult(KEY, bool(matches), weight, {
        "method": params.copy_method,
        "threshold": params.copy_similarity,
        "match_count": len(matches),
        "best_match": best,
        "matches": [
            {"submission_id": other.id, "similarity": round(value, 3), "relation": relation}
            for value, other, relation in matches[:_TOP_MATCHES]
        ],
    })

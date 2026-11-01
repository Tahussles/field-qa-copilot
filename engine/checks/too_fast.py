"""too_fast: the submission took less time than the minimum for this kind of contributor."""

from statistics import median

from ..model import CheckResult, Context, Submission

KEY = "too_fast"


def check(target: Submission, ctx: Context) -> CheckResult:
    weight = ctx.params.weights[KEY]
    if target.duration_sec is None:
        return CheckResult(KEY, False, weight, {"missing": "duration_sec"})
    threshold_sec = round(ctx.params.too_fast_min_minutes[ctx.contributor.kind] * 60)
    durations = [s.duration_sec for s in (*ctx.same_contributor, target) if s.duration_sec is not None]
    return CheckResult(KEY, target.duration_sec < threshold_sec, weight, {
        "duration_sec": target.duration_sec,
        "threshold_sec": threshold_sec,
        "kind": ctx.contributor.kind,
        "contributor_median_sec": median(durations),
    })

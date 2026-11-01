"""burst: too many submissions by one contributor inside a short window around this one.

Fires when some window of burst_window_minutes that contains the target holds
at least burst_min_count submissions (target included) for the contributor's kind.
"""

from datetime import timedelta

from ..model import CheckResult, Context, Submission, iso_utc

KEY = "burst"


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    window = timedelta(minutes=params.burst_window_minutes)
    min_count = params.burst_min_count[ctx.contributor.kind]
    times = sorted((s.captured_at, s.id) for s in (*ctx.same_contributor, target))

    best: tuple[int, int] | None = None  # (start index, end index exclusive)
    for i, (start, _) in enumerate(times):
        if start > target.captured_at:
            break
        if start < target.captured_at - window:
            continue
        j = i
        while j < len(times) and times[j][0] <= start + window:
            j += 1
        if best is None or j - i > best[1] - best[0]:
            best = (i, j)

    i, j = best  # the window starting at the target itself always qualifies
    fired = j - i >= min_count
    return CheckResult(KEY, fired, params.weights[KEY], {
        "window_minutes": params.burst_window_minutes,
        "min_count": min_count,
        "max_in_window": j - i,
        "window_start": iso_utc(times[i][0]),
        "window_end": iso_utc(times[i][0] + window),
        "submission_ids": [sid for _, sid in times[i:j]] if fired else [],
    })

"""off_hours: captured late at night in the project's local time.

Uses captured_at only, never synced_at, so late syncs of daytime work don't fire.
"""

from datetime import time

from ..model import CheckResult, Context, Submission

KEY = "off_hours"


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    start, end = time.fromisoformat(params.off_hours_start), time.fromisoformat(params.off_hours_end)
    local = target.captured_at.astimezone(ctx.tz)
    now = local.time()
    fired = (start <= now < end) if start <= end else (now >= start or now < end)
    return CheckResult(KEY, fired, params.weights[KEY], {
        "captured_local": local.isoformat(),
        "timezone": params.timezone,
        "window": f"{params.off_hours_start}-{params.off_hours_end}",
    })

"""clock_skew: the phone's clock disagrees with the server's.

The phone sends its own time when it syncs (device_synced_at); the server
stamps its own (received_at). They are seconds apart for a phone with a right
clock, so a gap above clock_skew_max_minutes means every time the phone reported
is off by about that much, as when a night's forms are backdated by setting the
clock back. A capture time later than the server's receipt is the same evidence
for a clock running ahead. A late sync (captured long before it arrived) is
normal offline work and never fires. Corroboration only: an honest phone can
have a wrong clock.

Without a phone clock (the synthetic waves, the simulator) the check cannot run.
"""

from ..model import CheckResult, Context, Submission, iso_utc

KEY = "clock_skew"


def _minutes(delta) -> float:
    return round(delta.total_seconds() / 60, 1)


def check(target: Submission, ctx: Context) -> CheckResult:
    params = ctx.params
    weight = params.weights[KEY]
    limit = params.clock_skew_max_minutes
    # The phone's capture time and the server's receipt, on the same (real) clocks: during a demo
    # captured_at and synced_at are on the field clock, so the device_* and received_at columns are read.
    if target.device_captured_at is not None:
        captured, received = target.device_captured_at, target.received_at
    else:
        captured, received = target.captured_at, target.received_at or target.synced_at
    if received is None:
        return CheckResult(KEY, False, weight, {"missing": "the server's receipt time"})

    if target.device_synced_at is not None:
        skew = _minutes(target.device_synced_at - received)
        basis = "sync"
    elif target.device_captured_at is not None or captured > received:
        skew = max(0.0, _minutes(captured - received))  # a capture before receipt says nothing about the clock
        basis = "capture"
    else:
        return CheckResult(KEY, False, weight, {"missing": "the phone's clock"})
    ahead_capture = _minutes(captured - received)
    fired = abs(skew) > limit or ahead_capture > limit
    if ahead_capture > limit and abs(skew) <= limit:
        skew, basis = ahead_capture, "capture"
    return CheckResult(KEY, fired, weight, {
        "skew_minutes": skew,
        "direction": "ahead" if skew > 0 else "behind" if skew < 0 else "none",
        "basis": basis,  # sync: device_synced_at vs received_at; capture: a capture time after receipt
        "limit_minutes": limit,
        "device_synced_at": iso_utc(target.device_synced_at) if target.device_synced_at else None,
        "received_at": iso_utc(received),
    })

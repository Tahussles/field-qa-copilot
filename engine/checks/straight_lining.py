"""straight_lining: the 8 satisfaction answers show no real variety.

Two patterns: all 8 identical, or a strict zig-zag between two values
(5, 4, 5, 4, ...), the one-step dodge of the identical rule. Looser tests (all
within one point, at most two distinct values) fire on about 260 genuine
interviews per tuning seed and are not used.
"""

from ..model import CheckResult, Context, Submission

KEY = "straight_lining"
ITEMS = 8


def check(target: Submission, ctx: Context) -> CheckResult:
    weight = ctx.params.weights[KEY]
    values = list(target.answers.get("satisfaction") or [])
    if len(values) != ITEMS:
        return CheckResult(KEY, False, weight, {"values": values, "missing": f"expected {ITEMS} answers"})
    distinct = len(set(values))
    alternating = distinct == 2 and all(v == values[i % 2] for i, v in enumerate(values))
    pattern = "identical" if distinct == 1 else "alternating" if alternating and ctx.params.straight_lining_alternation else None
    return CheckResult(KEY, pattern is not None, weight, {
        "values": values,
        "distinct_values": distinct,
        "pattern": pattern,
    })
